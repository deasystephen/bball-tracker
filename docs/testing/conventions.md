# Testing conventions

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

# Testing Requirements

When adding new features or fixing bugs, always write tests that verify behavior as it runs in the actual app:

## API Endpoints
- **Always add API integration tests** (in `tests/api/`) that test the full request/response cycle through Express routes
- API tests catch validation issues, middleware problems, and response format errors that service-only tests miss
- Test with realistic data formats (e.g., both UUID and custom string IDs if the database allows both)

## Validation Schemas
- **Add schema validation tests** (in `tests/schemas/`) for Zod schemas
- Test edge cases: empty strings, invalid formats, boundary values, required vs optional fields
- Ensure schema validation matches what the database actually accepts

## Service Layer
- Service tests (`tests/services/`) are valuable but not sufficient alone
- Service tests mock the database, so they don't catch mismatches between API validation and database constraints

## Test Coverage Principle
> Tests should exercise code paths as they run in production. If a request goes through validation → route → service → database, tests should cover that full path, not just the service layer with mocks.

## Example: What We Learned
A bug where the API rejected valid league IDs (`downtown-youth-league`) wasn't caught because:
1. Service tests bypassed API validation (called services directly)
2. No API tests existed for the seasons endpoint
3. Test factories used different ID formats than the seed data

The fix: Add API integration tests AND schema validation tests for every endpoint.

## Mobile copy & i18n
- **Screen tests render the real i18n instance.** Never stub `useTranslation` to return the key
  (`t: (k) => k`): that is how the #431 rebrand missed `roleOnboarding.title` for a week (#474) —
  Jest pressed `roleOnboarding.coachTitle` and never saw a locale value. `jest.setup.js` pins
  `expo-localization` to `en`, so `getByText('I coach a team')` works with no extra mocks.
- `__tests__/i18n/brand-guard.test.ts` fails CI on a retired brand name (the pre-rename product
  name and the pre-migration domain name; separators tolerated) in any `en.json`/`es.json` value,
  any line of any `.maestro/**/*.{yaml,yml}` (nested directories included), or any line of mobile
  source (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.json` under `mobile/`, minus native/build dirs,
  `package-lock.json`, and `__tests__/`, whose negative fixtures quote the old names) — comment
  lines included, so reword historical notes instead of quoting the old name. `ALLOWED_DOMAINS`
  (hostnames stripped before matching) has been **empty since the 2026-09 domain migration
  (#502)**: the old domain used to be allowlisted while it was live in mobile source; now any
  leftover link to it fails CI, and the stripping logic is covered by a synthetic entry in the
  self-test. Scope is mobile only — `backend/tests/services/mailer.test.ts` runs the same retired
  patterns over every rendered email template.

## Real-database suites (`backend/tests/integration/*.db.test.ts`)
- They unmock Prisma and write real rows, in CI's Postgres and in a developer's local one,
  next to the fixtures the Maestro flows depend on. `npm test` runs them with everything else;
  `npm run test:db` runs only them (`docker-compose up -d`, then `npx prisma migrate deploy` once).
  CI provides the database on every backend PR (`ci.yml` starts `postgres:18` and exports
  `DATABASE_URL`). A suite that finds no database **fails** with the start-up command; it never skips.
- **Why they exist (#458):** every other suite mocks Prisma, so an authorization assertion there is
  `toEqual` on the `where` object the author wrote. It cannot catch an `OR` where an `AND` was meant,
  a relation filter that matches a different row set than assumed, or NULL semantics. Every access
  clause (`teamAccessWhere`, `getReadableLeagueIds`, `listTeams`, `listGames`, player stats) has a
  suite here with one caller per branch, each qualifying through exactly one, so a dropped branch
  fails a test and a widened one fails a negative. When adding a clause, add it here too, and prove
  the suite bites once by breaking a branch on purpose.
- **Build fixtures with `tests/support/db-fixtures.ts#DbFixtures`** (`new DbFixtures(prisma, '<label>')`):
  `requireDatabase()`, `user(key, role)`, `org(key)` (league + active season + team + head-coach
  role; `{ league }` adds a sibling team to an existing one), `staff`, `member`, `leagueAdmin`,
  `guardian`, `personalLeague`, `game`, and `cleanup()` in `afterAll`. Two independent orgs are two
  `org()` calls. The older suites inline the same builders; new ones use the helper.
- **Name every row with the run id** (`const RUN = randomUUID().slice(0, 8)`): user name
  `<key>-<run>` and email `<local>.<run>@example.test`, league `ZZ-<label>-<run>`, team
  `<label>-<run>`. Never use an `@example.com` address in a suite: that domain is the seed's.
- **Clean up with `removeTestRows(prisma, { run: RUN, alsoUserIds })`**
  (`tests/support/test-leftovers.ts`), never with a list of ids alone: a test that throws before
  it records a row then leaves it behind (#584). `alsoUserIds` is for rows that lose their run
  id on the way, such as an account the test deletes, which becomes a tombstone with no address.
- The seed calls `removeTestRows(prisma, 'all')` for what an interrupted run left. **Never call
  the `'all'` scope from a test:** suites run in parallel against one database, and it would
  delete the rows of a suite that is still running. Read with `findTestRows` instead.
- The helper refuses to run when `NODE_ENV` is `production` or `DATABASE_URL` names an RDS host.
- `npm run db:reset` and `npm run db:fresh` (`prisma/reset.ts`, a full wipe) carry the same two-signal
  guard and one more: `prisma/reset-guard.ts#assertResetAllowed` also refuses any `DATABASE_URL` host
  that is not loopback or the docker-compose `postgres` service, before the Prisma client is built.
  No environment variable overrides it (the seed's `SEED_ALLOW_PRODUCTION` does not apply).
  `tests/prisma/reset-guard.test.ts` covers the branches and checks the call precedes the first
  `deleteMany` (#784).
- `tests/integration/test-leftovers.db.test.ts` plants leftovers next to look-alikes shaped like
  seeded fixtures and proves the look-alikes survive. When changing a pattern, loosen it on
  purpose once and confirm that suite fails.

## Migration backfill guard (#493)
- `ci.yml` applies migrations to an **empty** database, so it cannot see a backfill fail. The
  check **Migration backfill guard** (`.github/workflows/migration-backfill-guard.yml`) runs on
  every pull request: it puts a throwaway Postgres on the **base** commit's schema, seeds it
  from the base checkout, then runs `prisma migrate deploy` from the pull request. It exits at
  once when the pull request adds no migration.
- Run it before pushing a migration: `.github/scripts/migration-backfill-guard.sh` (Docker
  running, about half a minute). It starts its own container and never touches the database in
  `backend/.env`.
- **The base checkout does the seeding, on purpose.** The seed imports the generated Prisma
  client, and a client generated from the new schema cannot write to a database that is still
  on the previous one. Do not "simplify" it to one checkout.
- It also fails when a migration that is already on `main` is edited or removed: that migration
  has run in production.
- **Seed coverage is the limit.** A backfill on a table the seed leaves empty passes without
  running on a row; the log names those tables on every run. When a migration backfills such a
  table, add rows for it to `backend/prisma/seed.ts` in an **earlier** pull request (the guard
  seeds from the base branch), or rehearse on a restored snapshot. Details and the recorded
  proof: [`docs/testing/migration-backfill-guard.md`](../testing/migration-backfill-guard.md).
- The script and the workflow live under `.github/`, outside the path filter that makes a merge
  deploy. The Postgres image is read from `docker-compose.yml`, so the major stays pinned in
  the places `tests/infra/postgres-version.test.ts` already checks.

## Manual API smoke scripts (`backend/scripts/`)
- `backend/scripts/test-players-api.sh [BASE_URL] [ACCESS_TOKEN]` exercises `/api/v1/players` against a
  local `NODE_ENV=development` backend; with no token it dev-logins as the seeded admin. Its guide,
  with the cURL equivalents and the status each one returns, is `backend/docs/players-api-testing.md`.
  These scripts are manual only (not in CI) and must never be pointed at production.
