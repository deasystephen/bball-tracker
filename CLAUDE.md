# CLAUDE.md

Guidance for Claude Code in this repository. This file holds **commands, hard rules and pointers**. The as-built detail of every subsystem lives in `docs/` (index below) and loads only when a task needs it. **Keep this file at most 200 lines and 40K characters**: a change that needs more than a line or two here goes into the matching `docs/` file, with a one-line pointer from here.

## Project Overview

Hooplings (formerly "Basketball Tracker"; the repo, the `bball-tracker` EAS slug and the `com.bballtracker.mobile` bundle id keep the old identifier, the URL scheme is `hooplings://`) is a monorepo with three packages: a React Native/Expo mobile app (`mobile/`), a Node.js/Express backend (`backend/`) and a Next.js web app (`web/`) that hosts the public `hooplings.com/invite/<token>` accept flow. Real-time game tracking uses Socket.io backed by PostgreSQL; statistics are computed when games finish. Production is `api.hooplings.com` (ECS Fargate, single task) and the iOS app ships through TestFlight plus EAS OTA updates.

Architecture diagram: `README.md` (iOS app → Express API → PostgreSQL via Prisma, Redis cache).

## Where the detail lives

| Topic | File |
| --- | --- |
| Backend layout, Redis, uploads, URLs, calendar feed, push | `docs/architecture/backend-services.md` |
| Sessions, tokens, refresh, logout, PKCE, log redaction | `docs/architecture/auth-sessions.md` |
| Authorization rules (leagues, seasons, teams, games, staff, player directory) | `docs/architecture/authorization.md` |
| Roster, unified Add Player, invitations, status chips | `docs/architecture/roster-and-invitations.md` |
| Guardians / PARENT role | `docs/architecture/guardians.md` |
| Entitlements, usage metering, comped tiers | `docs/architecture/entitlements-and-usage.md` |
| Socket.io broadcast, server-derived score, tracker undo | `docs/architecture/live-games.md` |
| Stats finalization, ties, team lineage | `docs/architecture/stats-and-lineage.md` |
| Account deletion (as built) | `docs/architecture/account-deletion.md` |
| Email: SES events, bounces, complaints, audiences | `docs/architecture/email.md` |
| Mobile app: routing, guards, permission gating, errors, pickers, analytics | `docs/architecture/mobile-app.md` |
| Mobile analytics: Amplitude event catalogue, user properties, screen views, guard test | `docs/architecture/analytics.md` |
| Mobile builds, runtime versions, OTA drift guard, URL scheme, eas-cli | `docs/deployment/mobile-builds-and-ota.md` |
| ECS deploys: task definition, circuit breaker, what a deploy carries | `docs/deployment/ecs-deploys.md` |
| Runbooks index (on-call, email deliverability, data-subject requests, RDS) | `docs/runbooks/README.md` |
| Testing conventions (API tests, schema tests, real-database suites, migration guard) | `docs/testing/conventions.md` |
| Maestro E2E flows and their gotchas | `docs/testing/maestro.md` |
| Dependency automation | `docs/automation/daily-upgrade-scan.md` |

Path-scoped rules in `.claude/rules/` (`backend.md`, `mobile.md`, `maestro.md`, `infra.md`) load when Claude reads a file under the matching directory.

## Common Commands

### Backend (`/backend`)
```bash
npm run dev              # Dev server with hot reload
npm run build            # Compile TypeScript
npm run lint             # ESLint (--max-warnings 0)
npm run type-check       # Type check without build
npm test                 # Jest
npm test -- --testPathPattern="game"   # One test file
npm run test:db          # Only the real-database suites (needs docker-compose Postgres, migrated)
npm run prisma:generate  # Regenerate the Prisma client after schema changes
npm run prisma:migrate   # Run database migrations
npm run prisma:studio    # Prisma Studio GUI
npx prisma db seed       # Seed dev-login users, teams and games (also the reset between Maestro flows)
```
After pulling `main`, run `npm install` in `backend/` if you see TS2307 errors on new deps.

### Mobile (`/mobile`)
```bash
npx expo run:ios            # Build + run on the iOS simulator (native modules need a real build)
npx expo run:android        # Build + run on the Android emulator
npm run lint                # ESLint (--max-warnings 0)
npm run type-check          # Type check
npm test                    # Jest (includes the OTA drift guard)
```
- **Never** `npm start` / `npx expo start` / Expo Go: native modules need the dev client that `expo run:*` builds. There is no `expo-dev-client`; a Debug build with Metro stopped shows a red "No script URL provided" screen, which is not a build failure.
- Toolchain versions (Expo SDK, React Native, React) are whatever `mobile/package.json` says; the iOS and Xcode minimums, signing, certificate and ad-hoc `xcodebuild` details are in `docs/deployment/mobile-builds-and-ota.md`.
- **Never build SDK 57 with `CODE_SIGNING_ALLOWED=NO`**: an unsigned build has no entitlements, so the keychain refuses every call and the session tokens are never stored while the app looks fine.
- After checking out a branch that changes `scheme` or another native config value, run `npx expo prebuild --platform ios --clean` before `npx expo run:ios`; `run:ios` alone reuses the stale `ios/` project.

### Web (`/web`)
```bash
npm install && npm run dev   # http://localhost:3000
npm run lint && npm run type-check && npm run build   # lint is ESLint --max-warnings 0; CI runs all three
```

### Mobile builds and OTA (EAS)
```bash
eas build --platform ios --profile preview          # TestFlight-style build
eas build --platform all --profile production       # Store builds
cd mobile && npm ci && npm run ota:production -- --message "description"   # Production OTA (runs the drift guard first)
```
- **An OTA ships JavaScript against the native code frozen in the binary.** Packages with native code move only with a native build and a new runtime version: bump `version` in `app.config.js` (`runtimeVersion` policy `appVersion`), cut the build from the branch, **verify it on a device**, record it with `BINARY_BUILD=<n> BINARY_COMMIT=<sha> npm run binary-manifest:record`, then merge. Never edit `mobile/binary-manifest.json` by hand; it lists every runtime recorded since the guard was built (1.4.0 onward) and which build it is.
- `eas update` evaluates `app.config.js` on your machine: always pass `--environment production` and check that the CLI lists `APP_ENV` among the loaded variables, or the update ships `apiUrl: http://127.0.0.1:3000`. An update runs on the **second** launch after download.
- Entitlements, permission purpose strings, icons and splash are native: they ship with the next `eas build`, never an OTA.
- Use `npx eas-cli` (project dependency). The `overrides` block in `mobile/package.json` must keep `@oclif/core > minimatch ^10` scoped to `@oclif/core` only.

### Infrastructure
```bash
docker-compose up -d     # PostgreSQL 18 + Redis (after the PG 15→18 bump: docker-compose down -v first)
docker-compose down
```

## Architecture rules

Layered: API routes → services → Prisma. Zod validates every input. Backend service methods have explicit return types built from named `include`/`select` constants (`const X_INCLUDE = {...} satisfies Prisma.XInclude`; `Prisma.XGetPayload<…>`); extend those constants rather than inlining a new `include`. State in mobile: Zustand (client) + TanStack Query (server). Auth: WorkOS AuthKit; the JWT is the session token, WorkOS is the identity provider.

### Authorization (`backend/src/utils/permissions.ts`)
- **The global `User.role` is never an access check**; it only short-circuits ADMIN and gates team creation. Everything else goes through staff flags, league admin rows, membership and guardian links. Before writing "who may read this team" anywhere, use `canAccessTeam` (one team) or `teamAccessWhere` (a set); copies drift.
- List and detail endpoints for leagues and seasons are caller-scoped; an unaffiliated caller gets **404, not 403**, so ids cannot be probed (same for `GET /players/:id`). Denials elsewhere are `ForbiddenError` (403), never 400.
- `POST /teams` is **two independent checks**: WHO may create (ADMIN, `COACH`, any league admin) and WHERE (`canWriteLeague` when `seasonId` is given). Never use a read predicate as a write gate. Omitted `seasonId` means the caller's personal league.
- Head and assistant coach share the same five flags; staff management and team deletion key off `TeamRole.type` via `isHeadCoach` / `canManageStaff`. The last head coach can never be removed.
- Emails in payloads: roster `player.email` (and the SES suppression fields) only for callers with `canManageRoster`; staff emails for every team member. `GET /teams` list items carry the **caller's own staff row**; the mobile create-game gate depends on it.
- The invitation `token` is a bearer secret: read invitations through the `INVITATION_*_SELECT` constants and `omitToken`, never an `include`; only the public by-token routes touch it.
- `profilePictureUrl` is client-supplied and later **deleted** from S3 by `deletePreviousAvatar`: every path that stores one calls `upload-service.ts#assertOwnUploadUrl(url, callerId)` first (own `avatars/<callerId>/<file>` prefix on the parsed path, or an external URL). Detail: `docs/architecture/backend-services.md`, Avatar uploads.
- **Every "which row holds this email" filter is `utils/email-match.ts#emailEquals`**, never a raw `{ equals, mode: 'insensitive' }` (Prisma compiles it to an unescaped `ILIKE`; a guard test fails on the raw form). New accounts store `trim().toLowerCase()`.
- Every write onto a `User` row is guarded by `deletedAt IS NULL`; read tombstone state from `deletedAt`, never from the name or email. A new relation on `User` must be added to `USER_REFERENCE_SELECT` in `account-service.ts` (a test parses the schema and fails otherwise).
- Every write that changes or removes `User.email` spreads `EMAIL_SUPPRESSION_CLEARED`.
- Structured error bodies come only from `DetailedError.body()`; entitlement denials are **402** `upgrade_required`. Tier limits are single-sourced in `services/entitlements/index.ts#USAGE_LIMITS`; every value is `Infinity`, and the cap machinery stays mounted so a finite value there is enforced with no other change.

### Data and invariants
- A `Team` row **is a team-season** (`seasonId` required); persistent identity is `lineageId`. Rollover creates a new `Team` row with the same lineage, never moves `seasonId` on a row with history.
- `Game.homeScore` is derived from `SHOT` events inside the same transaction, after `SELECT … FOR UPDATE`; `PATCH /games/:id { homeScore }` is honoured only while the game has no shot events. The mobile tracker never sends `homeScore`.
- Stats: `finalizeGameStats` is idempotent and re-runs on any event change to a FINISHED game. Season shooting percentages are Σmade / Σattempted, never a mean of per-game percentages. Ties are `'T'`, never a loss.
- Cross-row writes that must not leave orphans run in one `$transaction` (team create, Add Player, account deletion, supersede-resend, personal-league provisioning). Personal-league provisioning upserts are native `INSERT … ON CONFLICT` and converge on their own; the `FOR UPDATE` lock on the caller's `User` row serializes the tier-cap re-check and provisioning per caller. Never add a P2002 retry.
- Multi-statement backfills are **hand-written migrations** (nullable column → backfill → `SET NOT NULL`); run `.github/scripts/migration-backfill-guard.sh` before pushing one. Never edit or remove a migration that is already on `main`.
- Redis is a best-effort cache; every helper fails open. Keep it that way.

### Socket.io and replicas
Rooms and rate-limit counters are in process memory, so the API is **single-replica**: autoscaling `max_capacity` is validated to 1, `MAX_REPLICAS=1` is in the task definition and `utils/replica-guard.ts` exits before listening on anything else. Do not raise capacity as a fix for load; the Redis adapter (#452) comes first. Every broadcast carries the current score so a client that drops events still converges. Event table and handshake recovery rules: `docs/architecture/live-games.md`.

### URLs, email and logging
- `PUBLIC_APP_URL` (web apex) and `API_BASE_URL` (API host) are read **only** via `utils/urls.ts`. The product name in email comes only from `services/mailer/templates/brand.ts#APP_NAME`; the support address is `SUPPORT_EMAIL` there and in mobile `config/env.ts` (a test pins them equal).
- Every email template ends with the shared footer and is listed in `renders` in `tests/services/mailer.test.ts`. Never format a date in a template with a bare `toLocaleDateString()`; use `utils/format-date.ts` (ECS runs in UTC).
- Every email flag returned to a client is per send (`emails.player`, `emailSent`); a failed SES send is reported, never thrown and never silent.
- Nothing in the app blocks a send to a bounced address; SES's suppression list is the gate and the next delivery clears the roster flag. Don't add an app-level skip.
- **Never log `req.originalUrl`**; use `utils/redact.ts` for any log line or Sentry field that carries a URL. Log `hashRecipient()` of an address, never the address.
- `LOG_LEVEL` is the log threshold (default `info`, set in `infra/task-definition.json`). A service method that mutates data logs one info-level domain event, ids only; `requestId`/`userId` come from the request context. No `console.*` in `src/`. Detail: `docs/architecture/backend-services.md#logging`.
- `CORS_ORIGIN` is a comma-separated list of exact origins, always passed as an array.

### Mobile
- The API host is decided in one place, `config/env.ts#getApiUrl()`; the sign-in redirect scheme is `APP_URL_SCHEME` passed explicitly (never read the scheme off the OTA manifest).
- **Derive, never inline**: roster chips via `utils/roster-status.ts#getRosterStatus`, bounce chips via `utils/email-delivery.ts`, game outcomes via `utils/game-result.ts`, shot text via `utils/shot-label.ts`, roster order via `utils/roster-sort.ts`, team brackets via `utils/team-labels.ts`, names via `utils/display-name.ts#displayName` (tombstones), and every permission via `hooks/useTeams.ts#hasTeamPermission`, `utils/team-permissions.ts` or `utils/game-permissions.ts`. The API stays the authority (403).
- Every date or time choice goes through `components/DateTimePickerSheet`; every per-row menu is `components/ActionMenu`, never an `Alert` (Android truncates at three buttons); every scrollable tab screen pads with `useTabBarPadding()`; sort pill rows are `components/SortPills`.
- **Never put a pressable inside a pressable** (VoiceOver and Maestro only see the outer one; a source-scanning test fails on it). A pushed screen that replaces itself with `ErrorState` passes `onBack={useGoBack(<parent>)}` (a test fails on a missing `onBack`). Toasts are non-interactive.
- Every hand-rolled pressable sets `accessibilityRole` (icon-only ones also an `accessibilityLabel`), single-choice pills mark `accessibilityState.selected`, and every control is a 44pt target via `utils/touch-target.ts` (`hitSlop` for icons, `minHeight` for text); source-scanning tests fail otherwise. Prefer `Button`, `Card onPress`, `ListItem`, and `BackButton` for a header's way back. Detail: `docs/architecture/mobile-app.md`.
- Screen titles and section headings carry the header role (`<ThemedText … heading>`), never on numbers; text scales everywhere and is capped (`MAX_FONT_SCALE`) only inside fixed-size controls, never `allowFontScaling={false}`. Source-scanning tests enforce both; detail in `docs/architecture/mobile-app.md`.
- Auth store: `updateUser(patch)` for local edits, `setUser` only at login. Prefer selectors (`useAuthUser`, `useIsAuthenticated`) over a bare `useAuthStore()`.
- **A request that needs a session is never sent without one.** A new unauthenticated endpoint must be added to `PUBLIC_PATHS` in `services/api-client.ts` or signed-out screens cannot reach it. `clearSession()` is idempotent and network-free; `logout()` is the remote sequence.
- Native modules are reached through `requireOptionalNativeModule` guards (`expo-secure-store`, `expo-application`), never the JS wrapper, so an OTA never crashes an older binary.
- Upload file parts are `expo-file-system` `File` objects; Expo's own `fetch` rejects the `{ uri, name, type }` object. Prove any new form encodes through the real encoder in a test.
- Jersey `0` is valid: test `jerseyNumber != null`, never truthiness.
- Amplitude tracking options are pinned in `services/analytics.ts`; changing one changes the privacy-label draft (`docs/release/app-store-submission.md`) in the same PR.
- Every new user-facing mutation hook fires a catalogued Amplitude event from its `onSuccess` (`trackEvent(AnalyticsEvents.X, props)`, ids only, never PII); new events go in `docs/architecture/analytics.md` in the same PR (a source-scanning test enforces both).
- Log through `services/log.ts`, never bare `console.*` (ESLint `no-console`). Sentry sees URLs only as `endpointPattern(url)`; the api-client captures network failures and 5xx, never 4xx.

## Code Style

- Files kebab-case, except in `mobile/` where React components are `PascalCase.tsx` and hooks are `useX.ts` (named after the primary hook they export; `hooks/query-keys.ts` stays kebab-case); classes/types PascalCase; functions/variables camelCase; constants UPPER_SNAKE_CASE. Explicit types over `any`; async/await over raw promises; Zod for inputs.
- **Never suppress lint errors** with `eslint-disable` and never downgrade a rule or raise `--max-warnings`: fix the code. The only exception is the `@typescript-eslint/no-namespace` disable on a `declare global { namespace Express }` augmentation of `Request` (today: `src/api/auth/middleware.ts` for `user`, `src/api/middleware/request-context.ts` for `requestId`). Warnings fail CI in every package.

## Testing Requirements

- **Tests exercise the path production runs.** A new or changed endpoint gets an API integration test in `tests/api/` (validation → route → service) and a schema test in `tests/schemas/`; service tests alone mock away the mismatches that ship.
- Backend `src/services/` has a CI-only 100% function-coverage threshold: a new method that every suite mocks turns CI red with all tests green.
- Real-database suites (`backend/tests/integration/*.db.test.ts`) name every row with a run id, use `@example.test` addresses (never `@example.com`, the seed's domain) and clean up with `removeTestRows(prisma, { run })`; never call the `'all'` scope from a test.
- Mobile screen tests render the **real i18n instance**; never stub `useTranslation` to return the key. `__tests__/i18n/brand-guard.test.ts` fails CI on any retired brand or domain name in mobile source, locale files or Maestro flows, comments included.
- Any major new mobile functionality ships with a Maestro flow in `.maestro/`. Flows are manual only, run sequentially with `npx prisma db seed` before **every** flow; a flow that mutates data needs a matching reset in `backend/prisma/seed.ts`. Selector and keyboard gotchas: `docs/testing/maestro.md` (also loaded as a rule when a flow is open).
- Jest, `expo export` and Maestro cannot see a JavaScript/native mismatch; a new runtime is verified **on a device** before merge.

## Work Hygiene

- **GitHub issues are the only source of truth for what is left to do.** Issues, milestones and the GA board own work with state; repo docs own durable truth reviewed in PRs; Claude memory owns cross-session facts that are not derivable from the repo; artifacts are dated snapshots. Never track a task in memory, a doc or an artifact; a within-run checklist lives in the session scratchpad, never in the repo. An audit's deliverable is issues; the document is provenance.
- **Before starting new work, ensure prior work is committed** and `git status` is clean. Several sessions share this checkout: never commit changes you did not make, and never `git reset`, `git stash` or `git checkout --` to get to a clean tree.
- **Keep going when a step needs no input from me**; status goes in the same message as the next action. Stop and ask (one question per turn) only when blocked, or before a mutating step that is hard to undo: merging to `main` (it can deploy), `terraform apply`, `eas build`/`submit`, force-pushing, deleting production data, writes to production AWS, or anything outside this repo or that changes this machine. The production OTA is not a stop (see Deploys). An unattended run (CI) has nobody to ask: follow its prompt. Detail: `docs/automation/claude-code-sessions.md`.
- **End every task with a wrap-up sweep, unprompted:** tests (Jest, API, Maestro), docs (`docs/`, this file, READMEs, the E2E test plan), open GitHub issues the change closes, unblocks or contradicts, and local `main` levelled with `origin/main` (Git Workflow).
- **Lead the closing message with what needs me**, then Changed, Verified, Wrap-up (what the sweep updated, or that nothing needed it). Mark anything you could not confirm and say where you looked.

## Documentation Hygiene

- **Keep docs in sync with code, in the same change.** Behaviour, API, schema, env-var, command and operational changes update the matching `docs/` file.
- **This file stays small.** Add at most a one-line rule plus a pointer here; the explanation, history and test names go in the `docs/architecture/`, `docs/deployment/` or `docs/testing/` file for that subsystem (create one if none fits). Issue and audit numbers, "before this fix" history and incident narratives belong in those files or in the issue, not here. The docs-check Stop hook warns when this file exceeds 200 lines or 40K characters.
- Forward references go stale: once referenced work lands, reword to past tense and distinguish "merged to `main`" from "deployed".
- The Stop hook `.claude/hooks/check-docs-updated.sh` reminds when code changed without any docs update. It is advisory.

## Git Workflow

- Single long-lived branch `main`; short-lived branches (`feature/…`, `fix/…`) merge via PR (squash). Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`. A PR opened outside `/ship` (which reviews the diff itself) gets a `/code-review` pass on the diff first.
- Delete a branch once its PR is MERGED (`gh pr list --head <branch> --state all`, then `git branch -D <branch> && git fetch --prune`), as part of landing it.
- **End every session with local `main` level with `origin/main`:** `git pull --ff-only` in the checkout that has `main` (or `git fetch origin main:main` when none does), then `git fetch --prune`; `git status --short --branch` must not say `behind`. Only ever fast-forward; if the tree is dirty or `main` has local commits, leave it and report it.
- Never write "does not close #N" in a PR body: GitHub reads it as a closing keyword.
- Tag major pushes with annotated semver tags (`git tag -a vX.Y.Z -m "…"`; `git push origin vX.Y.Z`).

## Deploys and operations

- **A push to `main` that touches `backend/`, `infra/`, `docker/` or `ci.yml` (minus Markdown) builds and deploys to ECS.** It ships everything waiting on `main` since the commit production runs (`curl -s https://api.hooplings.com/health` returns `commit`); read the run's "What this deploy carries" summary before blaming the change that started it. Dependabot's auto-merged backend bumps start no CI and wait; the daily scan's backend PRs deploy unattended.
- **Every deploy briefly splits live games** (single-replica Socket.io during the rolling overlap). Check for `IN_PROGRESS` games before merging anything that deploys or deploying by hand (`gh workflow run CI --ref main`).
- `infra/task-definition.json` is the **only** source of truth for the task definition (env vars, secrets, image). Terraform declares no task definition; a value written into `.tf` or `.tfvars` changes nothing and fails silently.
- **CI never applies Terraform.** `terraform apply` from `infra/` first, then merge; the merge of a `.tf` file still triggers a full ECS deploy that contains none of the infra change.
- `SES_CONFIGURATION_SET` must never be deployed ahead of the `terraform apply` that creates the set. Never add SES to the apex SPF or Google Workspace to the `mail.` subdomain.
- Production OTA is part of the ship workflow for mobile JavaScript changes: publish it in the same session as the merge and verify the served manifest.
- Runbooks: `docs/runbooks/` (on-call, email deliverability, data-subject requests, RDS backup and restore, PostgreSQL major upgrades). The privacy policy must match the retention section of `docs/runbooks/data-subject-requests.md`.

## Automation

Dependabot handles mechanical bumps (auto-merged once CI passes; its backend merges do **not** deploy). The Daily Upgrade Scan (`.github/workflows/daily-upgrade-scan.yml`, 15:00 UTC) runs Claude Code to add `overrides` for vulnerable transitives and handle JavaScript-only mobile bumps; packages with native code wait for the next binary (the OTA drift guard blocks them in CI). Design and deferral procedure: `docs/automation/daily-upgrade-scan.md`.

## Local Development Setup

1. `docker-compose up -d` (PostgreSQL 18 + Redis). A pre-PG-18 volume refuses to start; run `docker-compose down -v && docker-compose up -d`, then migrate and seed.
2. Backend: `cd backend && npm install && npm run prisma:generate && npm run prisma:migrate && npm run dev`.
3. Mobile: `cd mobile && npm install && npx expo run:ios` (never Expo Go).
4. Seed dev-login fixtures: `cd backend && npx prisma db seed` (`backend/prisma/seed.ts`).
