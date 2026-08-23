# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Basketball Tracker is a monorepo with three packages: a React Native/Expo mobile app, a Node.js/TypeScript backend, and a Next.js web app at `web/` that hosts the public `capyhoops.com/invite/<token>` accept flow (deep-links into mobile via Universal Links). It uses event-driven architecture with Kafka and Flink for real-time game tracking and statistics.

## Common Commands

### Backend (`/backend`)
```bash
npm run dev              # Start dev server with hot reload
npm run build            # Compile TypeScript
npm run lint             # ESLint check
npm run lint:fix         # Fix linting errors
npm run type-check       # Type check without build
npm test                 # Run Jest tests
npm test -- --testPathPattern="game" # Run single test file
npm run prisma:generate  # Generate Prisma client after schema changes
npm run prisma:migrate   # Run database migrations
npm run prisma:studio    # Open Prisma Studio GUI
```
**After pulling main**, run `npm install` in `backend/` if you see TS2307 errors on `@aws-sdk/client-sesv2` or similar — the SES mailer landing in #131 added new deps that the daemon won't notice without a fresh install.

### Mobile (`/mobile`)
```bash
npx expo run:ios            # Build + run on iOS simulator (preferred — native modules need this)
npx expo run:android        # Build + run on Android emulator
npm run lint                # ESLint check
npm run type-check          # Type check
```
**Do not use** `npm start` / `npx expo start` with this project — several native modules (Sentry, Reanimated, etc.) require a custom dev client built via `expo run:*`, not Expo Go.

### Web (`/web` — Next.js)
```bash
npm install     # First-time setup
npm run dev     # Local dev server on http://localhost:3000
npm run lint    # ESLint check
npm run build   # Production build
```

### Mobile Builds (EAS)
```bash
eas build --platform android --profile preview   # Android APK for testing
eas build --platform ios --profile preview        # iOS (requires Apple Developer account)
eas build --platform all --profile production     # Production builds for stores
eas update --environment preview --message "description" # OTA update to preview builds
npx eas-cli update --branch production --environment production --platform ios --non-interactive --message "description" # production OTA
```
**OTA env gotcha:** `eas update` evaluates `app.config.js` on *your* machine. `getApiUrl()` keys off `APP_ENV`; if it is unset the update ships `apiUrl: http://127.0.0.1:3000` (plus no Sentry DSN) and every device that takes it shows "Network error" on all API-backed tabs. The EAS `production` environment now provides `APP_ENV`, `SENTRY_ENVIRONMENT` and `SENTRY_DSN` (visibility *sensitive*, not *secret* — secret vars are builder-only and invisible to `eas update`). Always use `--environment production` and check the CLI line "Environment variables … loaded from the production environment" lists `APP_ENV`. (`AMPLITUDE_API_KEY` is *sensitive* too.) Remember an update runs on the **second** launch after it is downloaded.
**eas-cli pinning:** `mobile/package.json` pins `eas-cli ^22` and `eas.json` enforces `cli.version >= 22.2.0`. The `overrides` block must keep `@oclif/core > minimatch ^10` scoped to **@oclif/core only** — eas-cli itself needs the v5 default export, and giving it v9+ makes every credentials step fail with a misleading "Provisioning Profile is malformed" (#343).
```

### Infrastructure
```bash
docker-compose up -d   # Start local services (PostgreSQL, Redis, Kafka, Zookeeper)
docker-compose down    # Stop local services
```

## Architecture

### System Flow
```
iOS App (Expo/React Native)
    ↓ HTTP/WebSocket
Backend API (Node.js/Express)
    ├── PostgreSQL (Prisma ORM)
    ├── Redis (caching)
    └── Kafka → Flink (event streaming/aggregation)
```

### Backend Structure (`/backend/src/`)
- **api/**: Route handlers organized by resource (auth, games, teams, leagues, players, invitations, seasons, stats, uploads, middleware). `invitations/public-routes.ts` exposes the unauthenticated token lookup + accept used by the web invite page.
- **services/**: Business logic layer (game-service.ts, team-service.ts, etc.) plus `mailer/` (Mailer interface + FakeMailer + SesMailer + templates) shipped in #131 and `usage-service.ts` (usage metering, #43)
- **kafka/**: Kafka producers/consumers for event streaming
- **websocket/**: Socket.io handlers for real-time updates
- **models/**: Prisma ORM models
- **utils/**: Helpers (logger, errors, workos-client, redis caching helpers)

### Usage Metering & Tier Limits (#43)
- `services/usage-service.ts` exposes `getUsage(userId)` → per-feature `{ count, limit, limitReached }`. Counts are derived from live data at read time (no counter table) and cached in Redis for 60s (`utils/redis.ts` JSON helpers), invalidated on team create/delete.
- **Metered features**: `teams` (teams the user is staff on, vs tier `maxTeams`) and `seasons` (distinct seasons across those teams, vs tier `maxSeasons`). Limits are single-sourced from `utils/entitlements.ts` (`getUsageLimits`) — shared with the entitlement/feature-flag layer. `limit: null` means unlimited (paid tiers).
- **Endpoint**: `GET /api/v1/auth/me/usage` returns all metered metrics for the current user's effective tier.
- **Enforcement**: team create (`POST /api/v1/teams`) blocks FREE-tier users at/over the cap with a **402** (`PaymentRequiredError`); admins bypass.
- **Grandfather rule**: enforcement compares *current* count `>= limit` rather than `count + 1 > limit`. Users already over the cap when enforcement shipped keep all existing teams (never deleted/hidden) but cannot create new ones until under the limit or upgraded. Covered by tests in `tests/services/usage-service.test.ts` and `tests/api/usage.test.ts`.
- **Out of scope** (#43): per-day/per-hour rate limits, usage-based pricing, admin usage dashboards.

### Mobile Structure (`/mobile/`)
- **app/**: Expo Router screens (file-based routing)
- **components/**: Reusable UI components
- **services/**: API clients
- **store/**: Zustand stores (auth, user state)
- **hooks/**: Custom React hooks
- **i18n/**: Internationalization

### Socket.io (Live Game Broadcast)

Real-time game updates use Socket.io with an in-memory adapter. Single-replica
only — see `backend/src/index.ts` for the multi-replica startup guard and
issue #26 for the Redis adapter follow-up.

| Direction       | Event                | Payload                                |
| --------------- | -------------------- | -------------------------------------- |
| client → server | `join-game`          | `{ gameId }` (ack with success/error)  |
| client → server | `leave-game`         | `{ gameId }`                           |
| server → client | `game-snapshot`      | `{ game, events }` (on join / rejoin)  |
| server → client | `game-event`         | `GameEvent` (on persist)               |
| server → client | `game-status-change` | `{ gameId, status }` (on transition)   |

- Handshake auth: bearer token via `socket.handshake.auth.token` (or
  `Authorization` header). Checked once at connect; see `authenticateSocket`.
- Room naming: `game:<gameId>` (see `GAME_ROOM_PREFIX` / `gameRoom()`).
- Snapshot cap: `SNAPSHOT_EVENT_LIMIT = 100` most-recent events returned on
  join, in chronological order.

### Entitlements / Feature Gating

Subscription feature gating has a **single source of truth**:
`backend/src/services/entitlements/index.ts`. It owns the `Feature` enum, the
feature->tier map (FREE / PREMIUM / LEAGUE), usage limits, and the
`FREE_TEAM_LIMIT` constant (3). Do not redefine tier rules elsewhere — import
from there (issue #43's usage metering reuses these constants).

Enforcement lives in `backend/src/api/middleware/entitlements.ts`:

- `requireEntitlement(feature)` — gates a route behind a feature. On denial it
  returns **HTTP 402** with `{ code: 'upgrade_required', feature, currentTier, requiredTier }`.
  Applied to team season-stats CSV export (`STATS_EXPORT`) and calendar
  subscribe (`CALENDAR_SYNC`). System `ADMIN`s bypass all checks. Expired paid
  subscriptions resolve to an effective FREE tier.
- `requireTeamCreateLimit()` — enforces the FREE-tier team cap on `POST /teams`.
  **Grandfather rule:** the cap is checked only at create time. Users already
  over the limit KEEP their existing teams (nothing is deleted); they just
  cannot create new ones until under the cap or upgraded. PREMIUM/LEAGUE are
  unlimited and skip the count query.

### League / season / team / game authorization

Authorization helpers live in `backend/src/utils/permissions.ts` (`isSystemAdmin`, `isLeagueAdmin`,
`canAccessTeam`, `getTeamPermissions`). Rules enforced in the services (audit fix plan
`docs/plans/audit-fix-plan-2026-08-22.md`, lane B):

- **Leagues & seasons** (`league-service.ts`, `season-service.ts`): `getLeagueById(id, userId)` /
  `getSeasonById(id, userId)` return the **full detail** (league admins with emails, team staff with
  emails, rosters) only to system ADMINs and admins of that league. Everyone else gets league/season
  metadata plus team `{ id, name }` — no staff, no member lists, no emails. Authorization denials throw
  `ForbiddenError` (**403**, not 400); the league/season routes map any `AppError` to its `statusCode`.
  `PATCH /leagues/:id` enforces the same name-uniqueness rule as create (400 on duplicate).
- **Teams** (`team-service.ts`): `listTeams` always ANDs the caller's access clause (staff OR member OR
  league admin of the team's league) with any `seasonId` / `leagueId` / `playerId` filter — only system
  ADMINs skip it. `PATCH /teams/:id { seasonId }` moving a team into a different season requires
  `isLeagueAdmin` on the **target** season's league (in addition to `canManageTeam`), otherwise 403.
  `GET /teams/:id` includes `members[].player.email` only for callers with `canManageRoster`
  (head/assistant coach, league admin, system admin); players and stats-only staff get `{ id, name }`.
  Staff emails stay in the payload for every team member (coach contact info).

### Key Patterns
- Layered architecture: API routes → Services → Models (Prisma)
- Event-driven: Kafka for game events, Flink for real-time aggregation
- Real-time: Socket.io WebSocket for live game updates
- State management: Zustand (client) + TanStack Query (server state) in mobile
- Authentication: WorkOS (AuthKit). JWT is the session token format — WorkOS is the identity provider.

### Session tokens & refresh (#349)
- **Access tokens are verified locally** (`WorkOSService.verifyToken`): signature against the WorkOS JWKS for `WORKOS_CLIENT_ID` (via `jose` `createRemoteJWKSet`, cached, auto-refresh on unknown `kid`), `alg` ∈ {RS256, ES256}, and required `iss` (`WORKOS_JWT_ISSUER`, default `https://api.workos.com`), `exp`, `sub`. No WorkOS API call per request — the DB lookup by `workosUserId = sub` is the user check. Invalid/expired/forged → **401**; JWKS unreachable → **503** (`ServiceUnavailableError`), which mobile must treat as transient, not as a logout. The pre-2026-08 implementation only base64-decoded the payload (audit finding #1).
- WorkOS access tokens are **short-lived (minutes)**. `GET /auth/callback` returns both `accessToken` and a rotating `refreshToken`; `POST /auth/refresh { refreshToken }` returns a new pair (401 if WorkOS rejects it). `WorkOSService.refreshSession()` wraps `authenticateWithRefreshToken`.
- Mobile `services/api-client.ts`: on a 401 it performs a **single-flight** refresh (concurrent 401s share one call — WorkOS invalidates the old refresh token on use), stores the new pair via `setAuthToken(access, refresh)`, and replays the original request once. Auth endpoints (`/auth/refresh`, `/auth/callback`, `/auth/login`, `/auth/dev-login`) and already-retried requests never trigger a refresh. `refreshAccessToken()` is exported and resolves to a `RefreshOutcome`: `ok` (new token stored), `rejected` (no refresh token, or `/auth/refresh` answered **401**) → `logout()`, or `unavailable` (network error, timeout, 429, 5xx/503) → tokens are **kept** and the original error is surfaced to the caller; the next 401 retries the refresh (audit #20). A 401 from an auth endpoint itself never logs out from the interceptor.
- `auth-store` `onRehydrateStorage` clears `isLoading` via `setState` in both the success and the error branch (corrupt AsyncStorage starts the app logged out instead of stuck on "Loading…", audit #34). `app/login.tsx` clears its spinner when `AppState` returns to `active` while a browser sign-in is pending (user backed out of Safari, audit #33).
- `hooks/useAuthRedirect.ts` (mounted in `app/_layout.tsx`) routes to `/login` whenever `isAuthenticated` flips true→false, so a dead session can't strand the user on a tab. Cold-start routing stays in `app/index.tsx`.
- **Account type self-select (audit #9):** every WorkOS sign-up is created as `PLAYER`. `PATCH /auth/me/role { role: 'PLAYER' | 'COACH' }` (authenticated, general limiter) lets a user switch between those two; `ADMIN`/`PARENT` get 403 and `ADMIN` can never be selected. Mobile shows `app/onboarding/role.tsx` once per user after sign-in when the role is `PLAYER` (`utils/role-onboarding.ts`, flag `roleChosen:<userId>` in AsyncStorage) and again from Profile → "Change account type". `auth-store.updateUser(patch)` merges the new role without re-firing login analytics.
- Dev-login tokens (`dev_…`) have no refresh token and are only accepted when `NODE_ENV=development`.
- **Logout** (audit #51): `POST /auth/logout` (authenticated, no body) revokes the WorkOS session named by the token's `sid` claim via `WorkOSService.revokeSession`, which invalidates the bound refresh token. Responds `200 { success: true, revoked: boolean }` — `revoked: false` for dev tokens, tokens without `sid`, or a WorkOS outage (reported to Sentry); the client must clear local tokens regardless. `DELETE /auth/push-token` only deletes tokens owned by the caller (audit #47); call it *before* `/auth/logout` while the access token is still valid.
- The strict `authRateLimit` (20 req / 15 min / IP) applies only to `/auth/login`, `/auth/callback`, `/auth/refresh` and the dev endpoints; authenticated session routes (`/auth/me`, `/auth/me/usage`, `/auth/entitlements`, `/auth/push-token`) use the general API limiter.
- Sentry: `sentryErrorHandler` skips operational `AppError`s with status < 500 (`isExpectedClientError`) — an expired token is an expected outcome, not a defect. 5xx and non-`AppError` throws are still reported.

## Code Style

- **Files**: kebab-case (e.g., `game-service.ts`)
- **Classes/Types/Interfaces**: PascalCase
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- Prefer explicit TypeScript types over `any`
- Use async/await over raw promises
- Validate inputs with Zod schemas

### Lint & Warning Policy
- **Never suppress lint errors** with `eslint-disable` comments — fix the underlying issue instead
- **Never ignore warnings** — treat them as problems to solve, not noise to silence
- If a lint rule flags something, find the correct fix (e.g., use ES module `import` instead of `require()`, add proper types instead of `any`)
- The only acceptable exception is `declare global { namespace Express }` for extending Express types, which requires `@typescript-eslint/no-namespace` disable (see `src/api/auth/middleware.ts` for the pattern)
- **Warnings fail CI.** Each package's `npm run lint` runs `eslint . --max-warnings 0`, and the project rules in `eslint.config.mjs` are set to `error`, not `warn`. Do not downgrade a rule to `warn` or raise `--max-warnings` to get something merged — fix the code. (Backend hit 0 warnings in the lint burn-down of 2026-08-20; before that ~350 warnings had accumulated unnoticed because `eslint` exits 0 on warnings.)
- Backend service methods have explicit return types built from named Prisma `include`/`select` constants (`const TEAM_INCLUDE = {...} satisfies Prisma.TeamInclude` + `export type TeamDetail = Prisma.TeamGetPayload<{ include: typeof TEAM_INCLUDE }>`). Reuse/extend those constants rather than inlining a new `include` and leaving the return type inferred.
- CI must pass clean — do not merge code with lint errors or test failures

## Testing Requirements

When adding new features or fixing bugs, always write tests that verify behavior as it runs in the actual app:

### API Endpoints
- **Always add API integration tests** (in `tests/api/`) that test the full request/response cycle through Express routes
- API tests catch validation issues, middleware problems, and response format errors that service-only tests miss
- Test with realistic data formats (e.g., both UUID and custom string IDs if the database allows both)

### Validation Schemas
- **Add schema validation tests** (in `tests/schemas/`) for Zod schemas
- Test edge cases: empty strings, invalid formats, boundary values, required vs optional fields
- Ensure schema validation matches what the database actually accepts

### Service Layer
- Service tests (`tests/services/`) are valuable but not sufficient alone
- Service tests mock the database, so they don't catch mismatches between API validation and database constraints

### Test Coverage Principle
> Tests should exercise code paths as they run in production. If a request goes through validation → route → service → database, tests should cover that full path, not just the service layer with mocks.

### Example: What We Learned
A bug where the API rejected valid league IDs (`downtown-youth-league`) wasn't caught because:
1. Service tests bypassed API validation (called services directly)
2. No API tests existed for the seasons endpoint
3. Test factories used different ID formats than the seed data

The fix: Add API integration tests AND schema validation tests for every endpoint.

### Maestro E2E Tests
- **Any major new mobile functionality must include a Maestro E2E test** in `.maestro/`
- Flows test full user journeys: login → navigate → perform action → assert result
- All flows start with `clearState: true`, skip onboarding, and dev-login as a test user
- Use `accessibilityLabel` for tab bar navigation (e.g., `"Teams tab"`, `"Profile tab"`) since inactive tabs are icon-only
- When an `accessibilityLabel` exists on a parent element, Maestro uses that instead of inner text (e.g., `"Toggle dark mode"` not `"Appearance"`)
- For scrolling, use explicit coordinates to avoid hitting the raised Track button in the center tab bar (e.g., `start: 50%, 60%` / `end: 50%, 20%`)
- Run with: `maestro test .maestro/` or `maestro test .maestro/<flow>.yaml`

## Work Hygiene

- **Before starting new work, ensure prior work is committed.** If there are uncommitted changes from a previous feature, test them (`npm test`, `npx tsc --noEmit`), commit them on an appropriate branch, and verify a clean `git status` before beginning a new task. Mixing unrelated features in the same uncommitted diff makes testing and rollback difficult.

## Documentation Hygiene

- **Keep docs in sync with code.** When a change alters behavior, APIs, schema, env vars, commands, architecture, or operational steps, update the affected documentation in the **same change** — `CLAUDE.md`, `docs/` (architecture, runbooks, testing plans, automation), and any relevant `README`.
- **Forward-references go stale.** When you reference an unmerged PR or "incoming" work in docs, revisit it once that work lands and reword to past tense (e.g. "merged in #202", not "incoming"). Distinguish "merged to `main`" from "deployed to production" where it matters.
- A committed **Stop hook** (`.claude/hooks/check-docs-updated.sh`) prints a reminder when code files changed in the working tree without any `docs/` or `CLAUDE.md` update. It is advisory only — treat it as a prompt to confirm docs are current, not a blocker.

## Git Workflow

- Single long-lived branch: `main`. All work happens on short-lived feature branches that merge back into `main` via PR.
- Feature branches from `main`: `feature/your-feature-name`
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`
- **Tagging**: When pushing major changes to GitHub (new features, design overhauls, large refactors), create an annotated tag with `git tag -a vX.Y.Z -m "description"` and push it with `git push origin vX.Y.Z`. Use semantic versioning:
  - **Major** (vX.0.0): Breaking changes or architectural rewrites
  - **Minor** (v0.X.0): New features, design overhauls, significant improvements
  - **Patch** (v0.0.X): Bug fixes, small tweaks

## Automation

Dependency and security updates are split between **Dependabot** (mechanical patch/minor bumps, auto-merged by `.github/workflows/dependabot-auto-merge.yml` once CI passes) and the **Daily Upgrade Scan** (`.github/workflows/daily-upgrade-scan.yml`, `0 15 * * *` UTC) — a scheduled GitHub Actions job that runs Claude Code to add `overrides` for vulnerable transitives, handle mobile lockfile-only bumps, refresh the deferral issue, and post a daily summary on the rolling **Daily upgrade scan log** issue. The Claude prompt is `.github/prompts/daily-upgrade-scan.md`; design, secrets, and the deferral procedure are in [`docs/automation/daily-upgrade-scan.md`](docs/automation/daily-upgrade-scan.md).

## Operations / Runbooks

Production incident and recurring-ops procedures live in [`docs/runbooks/`](docs/runbooks/):

- **[RDS backup & restore](docs/runbooks/rds-backup-restore.md)** — verify automated backups, restore from snapshot, repoint the app via Secrets Manager, rollback path, and a user-facing comms template. The app reaches RDS via the endpoint baked into `bball-tracker-production/database-url` in Secrets Manager (not via Route53), so a restore is: new instance → new secret version → `--force-new-deployment` on the ECS service.

## Local Development Setup

1. Start services: `docker-compose up -d`
2. Backend setup:
   ```bash
   cd backend && npm install
   npm run prisma:generate
   npm run prisma:migrate
   npm run dev
   ```
3. Mobile setup:
   ```bash
   cd mobile && npm install
   npm start
   ```
