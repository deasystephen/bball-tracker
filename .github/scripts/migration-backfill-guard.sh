#!/usr/bin/env bash
#
# Migration backfill guard (#493).
#
# CI's backend job applies every migration to an EMPTY database, so the data
# statements of a backfill (UPDATE … SET, INSERT … SELECT, SET NOT NULL) run on
# real rows for the first time in production. This script runs the new
# migrations the way production meets them: on a database that is on the
# previous schema and already holds rows.
#
#   1. check out the base commit into a temporary git worktree
#   2. there: npm ci, prisma generate, migrate deploy, db seed
#      (the seed imports the generated client, so only the base checkout can
#      seed a database that is on the base schema)
#   3. from this checkout: migrate deploy against that same database
#
# It starts its own throwaway Postgres container on a random local port and
# removes it on exit. It never reads or touches the database in backend/.env.
#
# Usage:  .github/scripts/migration-backfill-guard.sh [base-ref]
#         base-ref defaults to the merge base of origin/main and HEAD.
#
# Limits: the seed is not production data. See docs/testing/migration-backfill-guard.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="backend/prisma/migrations"
DB_NAME="migration_guard"
DB_PASSWORD="postgres"

cd "$REPO_ROOT"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nMIGRATION BACKFILL GUARD FAILED: %s\n' "$*" >&2; exit 1; }

BASE_REF="${1:-}"
if [ -z "$BASE_REF" ]; then
  BASE_REF="$(git merge-base origin/main HEAD)" ||
    fail "could not find the merge base of origin/main and HEAD; pass a base ref"
fi
BASE_SHA="$(git rev-parse --verify "${BASE_REF}^{commit}")" ||
  fail "base ref '${BASE_REF}' is not a commit in this clone"

# ---------------------------------------------------------------------------
# What changed? Compared against the working tree, not HEAD, so a migration
# that is not committed yet is checked too.
# ---------------------------------------------------------------------------
base_migrations="$(git ls-tree -d --name-only "$BASE_SHA" "$MIGRATIONS_DIR/" | sed "s#^$MIGRATIONS_DIR/##" | sort)"
head_migrations="$(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
new_migrations="$(comm -13 <(printf '%s\n' "$base_migrations") <(printf '%s\n' "$head_migrations"))"

# A migration on the base branch has already run in production. Editing or
# removing it changes nothing there and makes the recorded history a lie.
changed=""
for name in $base_migrations; do
  file="$MIGRATIONS_DIR/$name/migration.sql"
  if [ ! -f "$file" ]; then
    changed="$changed\n  removed: $name"
  elif [ "$(git hash-object "$file")" != "$(git rev-parse "$BASE_SHA:$file")" ]; then
    changed="$changed\n  edited:  $name"
  fi
done
if [ -n "$changed" ]; then
  fail "a migration that is already on the base branch was changed:$(printf '%b' "$changed")
Migrations that have been merged have run in production. Add a new migration instead."
fi

if [ -z "$new_migrations" ]; then
  log "No new migrations since $(git rev-parse --short "$BASE_SHA"). Nothing to check."
  exit 0
fi

log "Base: $(git log -1 --format='%h %s' "$BASE_SHA")"
log "New migrations to run against seeded data:"
printf '%s\n' "$new_migrations" | sed 's/^/  /'

# ---------------------------------------------------------------------------
# Throwaway Postgres, same image as local development.
# ---------------------------------------------------------------------------
command -v docker >/dev/null || fail "docker is required"
PG_IMAGE="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:[^[:space:]]*\)[[:space:]]*$/\1/p' docker-compose.yml | head -1)"
[ -n "$PG_IMAGE" ] || fail "could not read the postgres image from docker-compose.yml"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/migration-guard.XXXXXX")"
BASE_DIR="$WORK_DIR/base"
CONTAINER=""

cleanup() {
  status=$?
  if [ -n "$CONTAINER" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -d "$BASE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$BASE_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
  exit $status
}
trap cleanup EXIT

log "Starting $PG_IMAGE"
CONTAINER="$(docker run -d \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p 127.0.0.1::5432 \
  "$PG_IMAGE")"

# Over TCP on purpose: during initialisation the image runs a temporary server
# that listens on the unix socket only, and a socket check would pass too early.
ready=""
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d "$DB_NAME" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
[ -n "$ready" ] || { docker logs "$CONTAINER" >&2 || true; fail "postgres did not become ready in 60s"; }

PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$PORT" ] || fail "could not read the port docker assigned"

# Exported, so it wins over backend/.env: prisma.config.ts loads dotenv, and
# dotenv never overrides a variable that is already set.
export DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}?schema=public"
unset NODE_ENV

run_sql() {
  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" -At -F ' ' -c "$1"
}

# ---------------------------------------------------------------------------
# 1 + 2. Base checkout: previous schema, then rows.
# ---------------------------------------------------------------------------
log "Checking out the base commit"
git worktree add --detach "$BASE_DIR" "$BASE_SHA" >/dev/null

log "Base: installing dependencies"
(cd "$BASE_DIR/backend" && npm ci --no-audit --no-fund --loglevel=error)

log "Base: generating the Prisma client"
(cd "$BASE_DIR/backend" && npx prisma generate >/dev/null)

log "Base: applying the previous schema"
(cd "$BASE_DIR/backend" && npx prisma migrate deploy) ||
  fail "the base branch's own migrations did not apply to an empty database"

log "Base: seeding"
(cd "$BASE_DIR/backend" && npx prisma db seed) ||
  fail "the base branch's seed did not run. This is a problem on the base branch, not in the new migration."

log "Rows the new migrations will meet"
counts="$(run_sql "SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1")"
printf '%s\n' "$counts" | awk '$2 > 0 { printf "  %-28s %s\n", $1, $2 }'
empty="$(printf '%s\n' "$counts" | awk '$2 == 0 { print $1 }' | tr '\n' ' ')"
if [ -n "$empty" ]; then
  printf '\n  The seed leaves these tables EMPTY, so a backfill on them is not exercised:\n  %s\n' "$empty"
fi

# ---------------------------------------------------------------------------
# 3. This checkout: the new migrations, on that data.
# ---------------------------------------------------------------------------
if [ ! -x backend/node_modules/.bin/prisma ]; then
  log "Installing dependencies"
  (cd backend && npm ci --no-audit --no-fund --loglevel=error)
fi

log "Applying the new migrations to the seeded database"
(cd backend && npx prisma migrate deploy) ||
  fail "a new migration did not apply to a database that holds rows.
It would have failed the same way at container start in production.
A migration that fails half-way is recorded as failed and blocks every later deploy."

applied="$(run_sql "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1")"
for name in $new_migrations; do
  printf '%s\n' "$applied" | grep -qx "$name" || fail "migration $name is not recorded as applied"
done

log "OK: the new migrations applied to a seeded database on the previous schema."
