# Migration backfill guard

Issue: #493. Script: `.github/scripts/migration-backfill-guard.sh`. Workflow:
`.github/workflows/migration-backfill-guard.yml`.

## What it is for

The backend job in `ci.yml` applies every migration to an **empty** database. A migration that
backfills data (`UPDATE … SET`, `INSERT … SELECT`, then `SET NOT NULL`) therefore passes CI
without its data statements ever touching a row. They run on rows for the first time in
production, at container start (`docker/entrypoint.sh` runs `prisma migrate deploy`). A
migration that fails there leaves the new task unable to start; the ECS circuit breaker rolls
the service back, and the failed migration stays recorded in `_prisma_migrations` and blocks
every later deploy until it is resolved by hand.

The guard runs the new migrations the way production meets them: on a database that is on the
previous schema and already holds rows.

## What it does

1. Compares the migrations in the checkout with those on the base commit.
   - No new migration: it prints "Nothing to check" and exits 0. Nothing is started.
   - A migration that is already on the base branch was edited or removed: it fails. That
     migration has run in production; add a new one instead.
2. Starts a throwaway Postgres container (the image named in `docker-compose.yml`) on a random
   local port.
3. Checks out the base commit into a temporary git worktree and there runs `npm ci`,
   `prisma generate`, `prisma migrate deploy` and `prisma db seed`.
4. Prints the row count of every table, and names the tables the seed leaves empty.
5. Runs `prisma migrate deploy` from the checkout against that database.
6. Removes the container and the worktree, whatever the result.

The base checkout does the seeding because the seed imports the generated Prisma client. A
client generated from the new schema selects the columns the new migration adds, so it cannot
write to a database that is still on the previous schema.

All migrations a pull request adds are run, not only the newest.

## Running it

In CI it runs on every pull request to `main`, as the check **Migration backfill guard**. The
base is the tip of `main` the pull request's merge commit was built on.

Locally, from anywhere in the repository (Docker must be running):

```bash
.github/scripts/migration-backfill-guard.sh            # base = merge base with origin/main
.github/scripts/migration-backfill-guard.sh <base-ref> # any commit, branch or tag
```

It compares against the working tree, so a migration that is not committed yet is checked too.
It takes about half a minute. It never reads or writes the database in `backend/.env`: it
exports its own `DATABASE_URL`, which takes precedence over the file.

## What a failure looks like

A column added as `NOT NULL` with no default, on a table that holds rows:

```
Applying migration `20991231000000_guard_probe`
Error: P3018
Database error code: 23502
ERROR: column "guardProbe" of relation "Team" contains null values

MIGRATION BACKFILL GUARD FAILED: a new migration did not apply to a database that holds rows.
```

The fix is in the migration: add the column as nullable, backfill it, then `SET NOT NULL`
(`20260906120000_team_lineage` is the worked example).

## Limits

- **The seed is not production data.** The guard proves that the migration applies to the rows
  `backend/prisma/seed.ts` creates. It does not prove that it applies to production's rows,
  which include shapes the seed has never had (rows written by older versions of the code,
  duplicates that a new unique index would reject, values at the edge of a new constraint).
- **Tables the seed leaves empty are not exercised.** The log names them on every run. Today:
  `Announcement`, `CalendarFeedToken`, `GameRsvp`, `GuardianInvitation`, `PushToken`,
  `RefreshToken`. A backfill on one of those passes the guard without running on a row.
- **It checks that the migration applies, not that the result is right.** A backfill that fills
  a column with the wrong value passes.
- **It says nothing about duration or locking.** The seed is a few hundred rows.

For a backfill on a table that matters, the guard is the first check and not the last one:
rehearse the migration on a restored snapshot as well, following "Variant — rehearse a schema
migration on a restored copy" in [`docs/runbooks/rds-backup-restore.md`](../runbooks/rds-backup-restore.md).

## Proof

Recorded on 2026-09-29, when the guard was built.

| Case | Base | Result |
| --- | --- | --- |
| Three real migrations, the first of them the `TeamLineage` backfill | `e13df9e`, the commit before `20260906120000_team_lineage` | passed; all three applied to 2 teams, 5 games and 26 users |
| A throwaway migration adding a `NOT NULL` column to `Team` | `HEAD` | failed with `23502`, exit code 1 |
| An edit to a migration that is already merged | `HEAD` | failed before any container was started, exit code 1 |
| No new migration | `HEAD` | exit code 0, nothing started |

And in CI, on the same day:

| Pull request | **Test Backend** (empty database) | **Migration backfill guard** |
| --- | --- | --- |
| #598, the guard itself, no new migration | passed | passed in 11 seconds, nothing started |
| #599, a throwaway: `ADD COLUMN … NOT NULL` on `Team`, then `DROP COLUMN` | **passed** | **failed** with `23502` after 1 minute |

#599 is the case the guard exists for: the empty-database job applied the migration and went
green, and only the guard saw it fail. Its migration drops the column again so that the schema
ends unchanged on an empty database; a first version without the `DROP` also turned Test
Backend red, because the tests could no longer insert a team, which proved nothing about the
migration step. #599 was closed without merging.
