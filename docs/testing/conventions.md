# Testing conventions

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

# Testing Requirements

When adding new features or fixing bugs, always write tests that verify behavior as it runs in the actual app:

## API Endpoints
- **Always add API integration tests** (in `tests/api/`) that test the full request/response cycle through Express routes
- API tests catch validation issues, middleware problems, and response format errors that service-only tests miss
- Test with realistic data formats (e.g., both UUID and custom string IDs if the database allows both)
- Development-only routes are mounted only when `NODE_ENV=development` while the router module evaluates, so set the env first and restore it afterwards. Two patterns exist. The full app is loaded with a plain dynamic import of `src/index` into the shared registry (`tests/api/auth-dev-login.test.ts`, main `describe`). The router alone, or a "not mounted" case under another `NODE_ENV`, is loaded with `jest.isolateModulesAsync` and mounted on a bare `express()` app (`tests/api/dev-users.test.ts`; the "outside development" `describe` of `auth-dev-login.test.ts`). A "not mounted" case sends a body the mounted route would answer 400 and asserts Express's own `Cannot POST` 404: the isolated registry holds its own Prisma mock, so a lookup-based 404 proves nothing.
- A list route gets at least one API case asserting 400 for a rejected query value and that the service mock was not called; the full pagination and filter matrix lives in `tests/schemas/` (`list-queries.test.ts`).

## Mocks in API tests (backend)
- **A mocked service resolves the service's declared return type.** Type the value with the exported
  type (`const page: TeamList = { teams: [item], total: 1, limit: 10, offset: 0 }`) and never cast the
  whole value with `as unknown as Awaited<ReturnType<…>>`: that cast is what let four list suites mock
  a `pagination` key no service returns and assert on it for eight months (#762). When a fixture is
  looser than the Prisma payload, narrow the item, not the page. Assert the fields a client reads
  (`total`, `limit`, `offset` at the top level for teams, games, leagues and seasons; nested
  `pagination` only for players and invitations, whose services return it).
- **The shared Prisma mock (`tests/setup.ts#mockPrisma`) defines every delegate method `src/` calls.**
  `$transaction` hands its callback `mockPrisma`, so `tx.<model>.<method>` needs the method too.
  `tests/utils/prisma-mock-coverage-guard.test.ts` derives the models from `Prisma.ModelName` and the
  calls from `src/` (an identifier receiver such as `prisma`, `tx` or `db`, or a parenthesised or call
  expression; type arguments allowed) and fails naming each missing `<model>.<method>`; add it to the
  model's block as `<method>: jest.fn()` (#766). A real-service API test then needs no hand-built `tx`:
  `tests/api/invitation-transitions.test.ts` is the pattern. Reset any delegate whose implementation a
  test installs in `beforeEach` (`clearAllMocks` keeps implementations).
- **Shared test helpers live in `tests/support/`:** `auth-fixtures.ts` (`authUser(overrides)`, the
  six fields `authenticate` attaches; `devToken({ userId, exp? })`), `log-lines.ts`
  (`parseLogLines(spy)` for `console.log`/`console.error` spies; a non-JSON line fails) and
  `source-scan.ts` (`sourceFiles`, `stripComments`) for the backend source-scanning guards, which
  walk the tree in `beforeAll`, never at collection time.
- **Unused-dependency guard (#781).** `tests/utils/unused-dependencies-guard.test.ts` fails when a
  `dependencies` entry in `backend/package.json` is not imported by any file under `src/`, `prisma/`
  or `scripts/`, or by a root config file such as `prisma.config.ts`, and when an `@types/<x>`
  devDependency has no `<x>` dependency, devDependency or Node built-in. An import is `from`, a bare
  `import`, `import()`, `require` or `require.resolve`, subpaths included, with comments stripped. A
  specifier built in a template literal or a variable is not seen. Remove the package with
  `npm uninstall`. A package used without a visible import, or an `@types` package for a transitive,
  goes in the test's dependency or types allowlist with its reason; both are empty today.

## Slow suites and timeouts (#804)

The global Jest timeout stays at 10 s and is never raised to quiet a flake. A test that legitimately issues many sequential requests (`invitation-lookup-rate-limit.test.ts` sends 601) passes a per-test timeout (the third `it` argument) derived from its request count (`(count + 1) * per-request budget`), with a comment showing the arithmetic. Prefer shortening the work first: order-independent requests go out in bounded concurrent chunks. A timeout in a test that does not loop is usually a request that never ends or a reused supertest agent against a closed server; on a saturated machine, rerun it alone first, and fix the synchronisation, not the clock.

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

## Mobile source-scanning guards
- Guard tests that read mobile source walk it through `mobile/__tests__/helpers/source-files.ts`
  (`MOBILE_ROOT`, `sourceFiles(dir, extensions)`, `scanLines(fileName, text, pattern)`); a new guard uses
  it rather than copying a walker. Users today: `__tests__/a11y/{nested-pressables,error-state-way-back}`,
  `__tests__/utils/{game-result-guard,display-name-guard}` and `__tests__/types/shared-types-usage`.
  Each guard asserts it scanned a plausible number of files and carries a self-test table of lines it
  must report and accept.
- `__tests__/types/shared-types-usage.test.ts` (#771) fails CI on an export of `shared/types/index.ts`
  that no mobile app file imports (tests excluded). Only `mobile/` imports that file; delete a dead
  export rather than keeping it "for later".

## Mobile API contract fixtures (#767)
- The mobile response types are hand-written; the backend's named `*_SELECT`/`*_INCLUDE` constants are
  the contract. `mobile/__tests__/types/api-contract.test.ts` assigns JSON payloads recorded from a
  local backend (`mobile/__tests__/fixtures/api-contract/`: auth session user, `GET /teams` item and
  detail, `GET /games` item and detail, `GET /games/:id/events` items, `GET /invitations` item,
  `GET /players/:id`, `GET /stats/games/:id` box score, `GET /stats/teams/:id/players` item,
  `GET /stats/players/:id`, a player's guardian list, `GET /games/:id/rsvps` items, `GET /leagues/:id`
  (admin view), `GET /teams/:id/announcements` item and its replies) to the client
  types, so `npm run type-check` fails on a required client field the API never sends, and on a field
  typed non-null or required where the API sends `null` or omits the key. An optional client field the
  API never sends is not caught (a non-literal assignment has no excess-property check); the test pins
  the optional fields it was written for with explicit type assertions, and asserts that the tombstone
  fields (`isManaged`/`deletedAt` on user summaries, `playerDeletedAt`, `childDeletedAt`,
  `inviterDeletedAt`) stay required (#889); runtime checks pin presence and `string | null`, never the
  value. Only the guardian invitation views have no fixture (type assertions only). Fixtures last
  re-recorded 2026-10-17 at `main` after PR #875; the test header lists the seeded sign-ins used and
  the rows the seed lacks (RSVPs, announcements, a player-less event), which are created through the
  API on the throwaway backend, recorded, then deleted before re-seeding.
- Fixtures, not a type import from `backend/src/services`: CI's mobile type-check job installs only
  `mobile/` dependencies and cannot resolve `@prisma/client`. When a backend constant behind one of
  these endpoints changes, re-record the fixture in the same PR (run the backend locally, `POST
  /auth/dev-login` as a seeded user, call the endpoint, trim lists to one or two items) and keep the
  hand-made null/absent variants the test header lists.

## Mobile copy & i18n
- **Screen tests render the real i18n instance.** Never stub `useTranslation` to return the key
  (`t: (k) => k`): that is how the #431 rebrand missed `roleOnboarding.title` for a week (#474) —
  Jest pressed `roleOnboarding.coachTitle` and never saw a locale value. `jest.setup.js` pins
  `expo-localization` to `en`, so `getByText('I coach a team')` works with no extra mocks.
- `__tests__/declared-dependencies.test.ts` (#780) fails CI when a `package.json` dependency is named nowhere in source or config and is not on its commented allow-list. Runtime dependencies count only source and build config (a `jest.mock` does not keep one alive); `devDependencies` also count tests and Jest/ESLint config.
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
- **Every key in `en.json` exists in `es.json` with the same placeholders (#732).** A device set to
  Spanish renders `es.json` and silently falls back to English for a missing key, which is how 17
  keys (`roleOnboarding.*`, `teams.playerEmptyMessage`, `teams.playerEmptyAction`,
  `teams.createNotAllowed`) shipped English-only on Spanish devices. `__tests__/i18n/locale-parity.test.ts`
  flattens every file in `i18n/locales/` to dot-joined leaf keys and fails CI on a key missing from or
  extra in a locale, a leaf that is not a string, or a shared key whose sorted `{{placeholder}}`
  names differ from `en.json` (i18next format syntax counts by name: `{{count, number}}` is
  `count`), naming each offender. Add a new key to both files in the same change; a new locale file is
  picked up automatically.

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
- **Row locks and races get a suite here too**, since the Prisma mock runs `$transaction` as a plain
  callback and `$queryRaw` resolves whatever its SQL says. Covered: account deletion
  (`account-deletion.db.test.ts`), the game-row lock (`stats-finalize.db.test.ts`) and `createTeam`
  with personal-league provisioning (`team-create.db.test.ts`, #765). Three techniques:
  - **Race by repetition:** `Promise.allSettled` of two calls, repeated over a few rounds with fresh
    rows, and assert the row counts per round.
  - **Hold the lock from the test** in a `prisma.$transaction`, start the call under test, then call
    `tests/support/db-locks.ts#waitForBlockedBy(tx, await backendPid(tx), { tables })`. It polls
    `pg_blocking_pids` until the call is waiting on the holder, returns the tables it already holds
    locks on (none means it waits before its first write), and throws a descriptive error on timeout.
    Never use a fixed sleep for this. Hold a `User` row with `FOR NO KEY UPDATE`, not `FOR UPDATE`: a
    `FOR UPDATE` also blocks the `KEY SHARE` lock that every foreign-key insert takes on the referenced
    row, so the call waits even with its own lock removed. The services pass no transaction options,
    so a blocked call dies with P2028 after Prisma's default 5 s: keep the holder's `timeout` well
    under that (`PRISMA_TRANSACTION_TIMEOUT_MS` in the same file).
  - **Prove it bites:** remove the lock statement, then move it later, and watch a test fail each time.
    A race that a native `INSERT … ON CONFLICT` already absorbs will not fail; check the emitted SQL
    with a `query` log listener before relying on a race test as the lock's guard.
- **Rehearse a migration's data statement on a shadow table** when the state it cleans up can no
  longer be built because the migration's own constraint forbids it. Inside one interactive
  `prisma.$transaction`, `CREATE TEMP TABLE "<Table>" (LIKE public."<Table>" INCLUDING DEFAULTS)
  ON COMMIT DROP` shadows the real table for that connection only (`pg_temp` is searched first),
  insert the rows, run the statement read from the migration file, read the survivors, then throw
  a sentinel so the transaction rolls back. The shared database's indexes are never dropped.
  Example: `team-staff-single-role.db.test.ts` (#463).
- `tests/integration/test-leftovers.db.test.ts` plants leftovers next to look-alikes shaped like
  seeded fixtures and proves the look-alikes survive. When changing a pattern, loosen it on
  purpose once and confirm that suite fails.
- **The seed's logic lives in `tests/support/`, not in `prisma/seed.ts`.** `prisma/*.ts` is outside
  `tsc` and ESLint and no test runs the seed, so anything in it that must agree with service code
  goes in `seed-fixtures.ts` (fixed ids, event logs, seeded games; pure) or `seed-resets.ts`
  (database resets: tombstone sweep, flow-created managed players, default roles, seeded-game
  restore, finished-game events under `lockGameRow`), and those call service functions
  (`createDefaultTeamRoles`, `computeHomeScore`) instead of copying them (#787). No fixture carries
  a `homeScore`. `seed-fixtures.test.ts` pins the data and only checks that the seed imports the
  resets; `tests/integration/seed-resets.db.test.ts` proves what the resets do, on run-id rows. A
  reset that sweeps globally takes a scope, so its test touches only its own rows.
- **Hard-deleting users goes through `test-leftovers.ts#deleteUsersWhere`**: it deletes the
  invitations they sent first (both `invitedById` foreign keys are `RESTRICT`, #783).
  `removeTestRows` and the seed's tombstone and managed-player resets use it.

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
- The guard seeds the **base** checkout. A base older than #926 (lazy WorkOS client) still throws at import without WORKOS env, so for such a base export `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` in the shell; the script no longer sets placeholders.
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
- The Node major has the same kind of parity test: `tests/infra/node-version.test.ts` ties the
  root `.nvmrc` (read by every `actions/setup-node` step), `backend/package.json` `engines.node`
  and `docker/Dockerfile` together (#714).

## Manual API smoke scripts (`backend/scripts/`)
- `backend/scripts/test-players-api.sh [BASE_URL] [ACCESS_TOKEN]` exercises `/api/v1/players` against a
  local `NODE_ENV=development` backend; with no token it dev-logins as the seeded admin. Its guide,
  with the cURL equivalents and the status each one returns, is `backend/docs/players-api-testing.md`.
- `backend/scripts/test-full-flow.sh` runs League → Season → Team → roster-only player (unified
  `POST /teams/:teamId/players`, no email so no invitation) → Game → SHOT event against a local dev
  server, dev-logging in as the seeded admin, and checks the server-derived score. The old curl
  walkthrough under `backend/docs/` was deleted in favour of it (#639).
- `backend/scripts/verify-setup.sh` checks the local setup (`node_modules`, `.env`, Prisma client,
  the two Docker containers, type check); see `backend/README.md`.

These scripts are manual only (not in CI) and must never be pointed at production.
