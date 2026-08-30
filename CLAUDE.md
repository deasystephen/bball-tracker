# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hooplings (formerly "Basketball Tracker" — the repo, `bball-tracker://` scheme, `bball-tracker` EAS slug and `com.bballtracker.mobile` bundle/package ids keep the old identifier) is a monorepo with three packages: a React Native/Expo mobile app, a Node.js/TypeScript backend, and a Next.js web app at `web/` that hosts the public `capyhoops.com/invite/<token>` accept flow (deep-links into mobile via Universal Links). It uses event-driven architecture with Kafka and Flink for real-time game tracking and statistics.

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
**Universal Links need a native build:** `app.config.js` sets `ios.associatedDomains: ['applinks:capyhoops.com']` (audit #37) so iOS trusts the AASA file and `capyhoops.com/invite/<token>` opens the app. Entitlements are baked into the binary at build time — an `eas update` (OTA) cannot add or change them, so any change here means cutting a new `eas build` and going through TestFlight again. The `capyhoops.com` web deploy must also be serving `/.well-known/apple-app-site-association` for the link to resolve.
**Runtime version 1.2.0 (audit #52):** `app.config.js` uses `runtimeVersion: { policy: 'appVersion' }`, so bumping `version` moves the OTA target. `1.1.0` → `1.2.0` happened when `expo-secure-store` (native) landed; every `eas update` from then on reaches **1.2.0 builds only** (build #25+). Build #24 keeps the last 1.1.0 OTA and gets nothing further — ship a native build before publishing OTAs that assume the keychain. Native-module additions are also dependabot-ignored (`.github/dependabot.yml`, `expo-secure-store` included) because the Expo SDK pins them.
**eas-cli pinning:** `mobile/package.json` pins `eas-cli ^22` and `eas.json` enforces `cli.version >= 22.2.0`. The `overrides` block must keep `@oclif/core > minimatch ^10` scoped to **@oclif/core only** — eas-cli itself needs the v5 default export, and giving it v9+ makes every credentials step fail with a misleading "Provisioning Profile is malformed" (#343).

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
- **Enforcement**: team create (`POST /api/v1/teams`) blocks FREE-tier users at/over the cap with a **402** (`PaymentRequiredError`); admins bypass. **Seasons are metered but never capped** — `maxSeasons` is `Infinity` for every tier, so `/auth/me/usage` reports `seasons.limit: null` and `limitReached: false`. The old FREE value of 1 was never enforced anywhere and rendered as a fake paywall (audit #81); season-history depth is the `FULL_SEASON_HISTORY` feature flag, not a usage limit. If a real cap is ever wanted, enforce it where a team joins a new season and re-add the number in one place (`USAGE_LIMITS`).
- **Race-safe**: `requireTeamCreateLimit` is only a cheap pre-check. The authoritative check runs inside `TeamService.createTeam`'s `$transaction`, after `SELECT … FROM "User" … FOR UPDATE` on the caller's row, so concurrent creates serialize and can't exceed the cap (audit #49); it throws `PaymentRequiredError` (402, same `upgrade_required` body). Team + default roles + Head Coach staff row are written in that same transaction (no orphan teams, audit #70).
- **Grandfather rule**: enforcement compares *current* count `>= limit` rather than `count + 1 > limit`. Users already over the cap when enforcement shipped keep all existing teams (never deleted/hidden) but cannot create new ones until under the limit or upgraded. Covered by tests in `tests/services/usage-service.test.ts` and `tests/api/usage.test.ts`.
- **Out of scope** (#43): per-day/per-hour rate limits, usage-based pricing, admin usage dashboards.

### Mobile Structure (`/mobile/`)
- **app/**: Expo Router screens (file-based routing)
- **components/**: Reusable UI components
- **services/**: API clients
- **store/**: Zustand stores (auth, user state)
- **hooks/**: Custom React hooks
- **i18n/**: Internationalization
- **assets/brand/**: Hooplings icon SVG masters ("Courtside Capy" capybara mark) + `render-icons.mjs`,
  which regenerates `assets/{icon,adaptive-icon,splash-icon,favicon}.png` (`node assets/brand/render-icons.mjs`
  from `mobile/`). Edit the SVGs, never the PNGs. Icon/splash changes are baked into the native binary —
  they ship with the next `eas build`, not an OTA. Brand navy `#1C2742` is also the splash and
  adaptive-icon background in `app.config.js`.

#### Mobile roster & invite-status chips (roster/invite unification)

- `app/teams/[id]/players.tsx` has ONE **Add Player** form (`useAddRosterPlayer` →
  `POST /teams/:teamId/players`): name required, optional player email (invite goes out when
  present), optional parent email + relationship chips (guardian invite in the same step,
  rostered cases only). The old "Create New Player" / "Add Roster Player" split and
  `useAddPlayerToTeam` are gone. Result handling: `rostered: false` (existing account) toasts an
  explanation; `emails.player/guardian === false` toasts an error (never silent);
  `guardianReason` surfaces as info.
- **Chips derive ONLY via `utils/roster-status.ts#getRosterStatus(member, team.invitations)`**
  (same never-inline rule as `game-result.ts`): Active = `player.isManaged === false` OR an
  ACCEPTED row; Invited/Invite expired from the PENDING row (expiry client-computed); else Not
  invited. `team.invitations` exists only for `canManageRoster` callers (stripped to `[]`
  otherwise) and carries rostered players only.
- **Resend and Invite are the same call**: `useCreateInvitation` with
  `{ playerId, supersede: true }` (fresh token server-side, old link dies). Resend renders on
  Invited/Expired rows; Invite on Not-invited rows **with an email on file**; Cancel
  (`useCancelInvitation`, confirm dialog) only on Invited rows — a lazily-expired row has no
  valid id to cancel. Cancel keeps the player rostered AND keeps their email (rejection-only
  strip) — recovery from a wrong email is `PATCH /players/:id { email }` then Resend, never
  re-adding (which would create a duplicate account).
- **Case-3 invitees** (existing accounts, not yet members) render in a separate "Invited"
  section from `useTeamInvitations(teamId, 'PENDING')`, filtered to non-members + unexpired
  (dedupe by `playerId` against `members[]`); search results also exclude them (re-selecting
  would 400 — Resend lives on the Invited row), and a failed invitations fetch renders an
  inline error + Retry instead of silently dropping the section.
- Per-player actions use `components/ActionMenu` (Modal bottom sheet) — never an `Alert`
  menu: Android caps Alert at three buttons and silently truncates. Chip accessibility
  labels are row-anchored (`"<player> status: <label>"`) and Maestro asserts that exact
  string — a bare `assertVisible: "Active"` can false-pass off a neighboring row.
- Every roster row's menu has **Edit jersey & position** (bottom-sheet form, prefilled with the
  `!= null` rule so jersey 0 renders) → `useUpdateTeamMember` →
  `PATCH /teams/:id/players/:playerId`; an emptied input sends `null`, which clears the stored
  value (`updateTeamMemberSchema` is `.nullable()` for both fields). This is the recovery path for
  members rostered without a number (e.g. pre-fix resend-superseded invites).
- Seeded chip fixtures on the Lakers (Iris Invited / Xander Expired / Wendy WebAccept /
  Marcus Johnson = Not invited). Maestro: `.maestro/roster-management.yaml` (add → immediate
  roster + chip) and `.maestro/roster-invite-status.yaml` (all four chips + action gating).
- **Roster ordering:** the backend returns `members` jersey-asc, nulls last, name tiebreak,
  then `id` (the shared `ROSTER_MEMBERS_ORDER_BY` in `team-service.ts`, imported by
  `GAME_DETAIL_INCLUDE.team.members`), so the team-detail and game-detail rosters carry a
  deterministic order; other roster-bearing queries (stats/season/league services) are still
  unordered. Known, accepted divergence: the team overview always re-sorts client-side via
  `sortRosterMembers` (both modes), whose name comparisons use device-locale `localeCompare`
  (`sensitivity: 'base'`), while server-ordered screens show raw Postgres-collation order —
  rows whose names differ only in case/accents can order differently between screens. The
  team overview (`app/teams/[id].tsx`) adds a Jersey #/Name sort toggle (pills render only
  with 2+ members): comparisons go ONLY through `utils/roster-sort.ts#sortRosterMembers`
  (never inline; jersey 0 is valid, no number sorts last), and the choice persists per user via
  `hooks/useRosterSortPreference.ts` (AsyncStorage `rosterSort:<userId>`, best-effort like
  `role-onboarding.ts`; hydration resets on userId change and never overwrites a tap).
  Sort pill rows are the shared `components/SortPills` (44pt targets, "Sort by <label>"
  a11y + selected state) — used by the team overview and team stats screens; don't
  hand-roll new pill rows. Maestro coverage lives in `.maestro/team-detail.yaml`.

#### Mobile list pagination & cache invalidation
- Server list endpoints default to `limit=20` (max 100). Scrolling screens use the `useInfiniteQuery` hooks
  (`useInfiniteGames`, `useInfiniteTeams`, `useInfiniteAnnouncements`) wired to `FlatList.onEndReached`; the
  returned `data` is `{ items…, total }` flattened across pages. Pickers that need *every* team (Stats tab,
  Profile, Create Game) call `useTeams({ limit: TEAMS_MAX_LIMIT })`.
- Games status filtering is **server-side** (`GET /games?status=`). The Games tab passes the active pill as the
  `status` filter; Home uses a dedicated `useLiveGames()` (`status=IN_PROGRESS`, small limit) for the live
  card, `useGames({ status: 'FINISHED', limit: 5 })` for recent results (the tile is labelled "Wins (last 5)"),
  and `useGamesPage({ status: 'SCHEDULED', limit: 1 }).total` for the Upcoming count. Never filter a
  date-desc first page client-side — a backlog of scheduled games hides live/finished ones.
- Infinite keys nest under the list root (`gameKeys.lists()`, `teamKeys.lists()`, `announcementKeys.team(id)`)
  so existing mutation invalidations cover them. `useUpdateGame` also invalidates `statsKeys.all` when a game
  becomes `FINISHED`; `useCreateTeam`/`useDeleteTeam` invalidate `usageKeys.all` (the FREE-tier meter).
- The tab bar (`app/(tabs)/_layout.tsx`) is an absolutely-positioned translucent blur overlay — content
  deliberately scrolls behind it. Every scrollable tab screen therefore sets its scroll-content
  `paddingBottom` from `hooks/useTabBarPadding.ts#useTabBarPadding()` (= `TAB_BAR_HEIGHT` 60 + bottom
  safe-area inset + `spacing.lg`); never hand-roll that padding — a too-small value leaves the last rows
  permanently trapped under the bar (the pre-fix Profile bug).

#### Mobile routing & guards
- The `(tabs)` shell has no auth guard of its own. Screens reachable while logged out (the `/invite/<token>`
  deep link) must send unauthenticated users to `/login` themselves. Use `setPendingReturnPath(path)` from
  `utils/return-path.ts` before pushing `/login`; `postLoginRoute()` (used by login, the OAuth callback and
  cold start) consumes it (30-minute TTL, in-app absolute paths only) after the role-onboarding check, so the
  user lands back on the deep link.
- Player routes: roster cards and leaderboards link to `/players/:id/stats`. There is no
  `/teams/:id/players/:playerId` or `/notifications` route — don't add links to them.
- `GET /stats/players/:id` returns **404** for a player with no team memberships; `app/players/[id]/stats.tsx`
  renders an `EmptyState` for that case ("No stats yet" for the current user) instead of an error.
- The Profile "Leagues & Seasons" entry is shown to system `ADMIN`s and to users with at least one league in
  `user.leagueAdminOf` (`utils/team-permissions.ts#canAccessAdmin`). See "Mobile permission gating" below.
- **About screen** (`app/about.tsx`, Profile → Settings → About): version + OTA diagnostics from
  `expo-constants` / `expo-updates` — app version, runtime version, applied update id + publish time
  ("Embedded build" when `!Updates.isEnabled || isEmbeddedLaunch || !updateId`, i.e. dev client or no OTA
  yet), channel, and a Share-sheet export (`formatAboutDiagnostics`) for OTA verification. This replaced the
  hardcoded version string in the Profile footer (it had drifted), and is the designated home for Terms of
  Service / Privacy Policy / open-source-license rows once #25 publishes the documents — don't add those
  links anywhere else. The App-version row appends the native build number ("v1.2.0 (build 28)") read via
  `requireOptionalNativeModule('ExpoApplication')` — never the `expo-application` JS wrapper, which would
  crash binaries without the module: `expo-application` first shipped in build #28 (cut 2026-08-28), and
  1.2.0 OTAs still reach builds #25–#27, where the row degrades to the bare version (same guard pattern as
  `services/secure-storage.ts`). `expo-application` is Expo-SDK-pinned and dependabot-ignored like the other
  native modules. Tests `__tests__/app/about.test.tsx` (note the
  lazy-getter `expo-updates` mock — Babel's `import * as` interop copies plain mock objects); Maestro
  `.maestro/profile.yaml`.

#### Mobile permission gating (role matrix M3, M8, M9, M12–M18, M27, M4.1, M4.2)
Every gated control mirrors a backend rule; the API is still the authority (403). Rules live in two helpers —
never inline a role check in a screen:
- `hooks/useTeams.ts#hasTeamPermission(team, userId, flag, userRole?, leagueAdminOf?)` — system `ADMIN` → true;
  a user whose `leagueAdminOf` contains `team.season.league.id` → true (matches backend `isLeagueAdmin`);
  otherwise the staff role flag. Accepts any `{ staff?, season? }` shape, so `game.team` from `GET /games/:id`
  (which includes `staff` + `season.league`) works without a second fetch.
- `utils/team-permissions.ts` — `canCreateTeams(user)` (COACH / ADMIN / any league admin), `canAccessAdmin(user)`
  (ADMIN or `leagueAdminOf.length > 0`), `canCreateLeagues(user)` (ADMIN only), `canManageLeague(user, leagueId)`
  (ADMIN or that league in `leagueAdminOf`). `utils/game-permissions.ts#getGamePermissions(game.team, user)`
  derives `{ canManage, canTrack, canChangeStatus, canEditFinished }` from the game rules in `game-service` /
  `game-event-service` (create/edit/delete → `canManageTeam`; start/end/score → `canManageTeam || canTrackStats`;
  record/undo → `canTrackStats`; rewrite a FINISHED game → `canManageRoster`).
- `user.leagueAdminOf?: string[]` is an **optional** field on the shared `User` type (populated by
  `GET /auth/me` / `GET /auth/callback` once the backend ships it); `undefined` means "admin of no leagues".
- Screens: Games tab FAB + `games/create` (teams the user can manage; bounce if none); `games/[id]` shows
  Start/End only with `canChangeStatus`, Delete with `canManage`, Continue Tracking with `canTrack` (players keep
  Watch Live / RSVP / box score); `games/[id]/track` guards itself (toast + `replace` to the game detail) because
  it is deep-linkable. Admin screens (`admin/*`), `teams/[id]/edit` (`canManageTeam`) and `teams/[id]/players`
  (`canManageRoster`) use `hooks/useAccessGuard.ts` (toast + `back()`, `replace(fallback)` when there is no
  history; returns `allowed` so the screen renders a spinner instead of flashing gated controls). League admins
  see only their own leagues in `admin/index`; league create/delete stay ADMIN-only.
- Teams tab shows the spinner until `user` has rehydrated — a `null` user must never render the player empty
  state. Home's "no teams → Create Team" card uses `canCreateTeams(user)` like the Teams tab.
- `hooks/useSessionRefresh.ts` (mounted in `_layout.tsx`) re-fetches `GET /auth/me` when a session becomes
  active and on every foreground (AppState → `active`), throttled to once per 5 min, and merges
  `role` / `leagueAdminOf` / `name` / `profilePictureUrl` via `auth-store.updateUser`. Failures are ignored.
- **Team staff screen** (`app/teams/[id]/staff.tsx`, role matrix decision 2 / B2.3): reached from the "Staff"
  card on team detail (coach names + count; the hero line lists every `HEAD_COACH`-type row from `team.staff`).
  Lists `GET /teams/:id/staff` (name, role, email when the API returns it). Readable by anyone with team access;
  **Add staff** (email + role chips), per-row role change and remove render only when
  `hooks/useTeams.ts#canManageStaff(team, userId, userRole, leagueAdminOf)` — ADMIN, admin of the team's league
  or a `HEAD_COACH`-type staff row (mirrors backend `canManageStaff`; flags can't tell head from assistant).
  Any staff member gets **Leave team** on their own row; the last head coach never gets a remove control. A
  `POST /staff` 404 (no account for that email) shows the inline "ask them to sign up first" hint — the
  endpoint never creates users. Hooks in `hooks/useTeamStaff.ts` (`useTeamStaff`, `useTeamRoles`,
  `useAddStaff`, `useUpdateStaffRole`, `useRemoveStaff`) invalidate the staff list, team detail/lists and
  `usageKeys.all` (staff rows feed the FREE-tier team cap). Maestro: `.maestro/team-staff.yaml` (Frank Vogel =
  seeded Lakers head coach, read-only); Jest `__tests__/app/team-staff-gating.test.tsx`.
- Maestro: `.maestro/player-no-tracking.yaml` (Steph Curry = seeded PLAYER) asserts the create FAB, Start Game,
  Delete game, Continue Tracking and End Game are absent while RSVP remains.
- **Guardians (PARENT role, role-matrix decision 1 / `docs/plans/parent-role-spec.md`).** `user.guardianOf?:
  { childId, childName, relationship, isPrimary }[]` is optional on the shared `User` type like `leagueAdminOf`
  (`useSessionRefresh` merges it). Helpers in `utils/guardian.ts` — `isGuardian(user)`, `guardianChildrenOnTeam(user,
  team)` (children rostered on a `{ members }` shape, works with `game.team`), `isRosteredOn`,
  `relationshipLabel`. Guardians have no staff row, so the gates above already hide every manage/track control.
  Screens: Profile → **"My kids"** (each child → `/players/:childId/stats`; "Change account type" is hidden when
  `guardianOf` is non-empty — PARENT is derived, never picked); game detail RSVP shows a **"Responding for"** chip
  row when the user is a guardian of ≥1 member of the game's team ("Me" only when the user is rostered; defaults to
  the first child otherwise) and sends `playerId` for a child (`useSubmitRsvp({ gameId, status, playerId? })`, the
  selected state reads the child's `rsvp.userId` row); Invitations tab renders `guardianInvitations` from
  `GET /invitations` ("Become <relationship> of <child> on <team>" / "Accept for <child>" / Decline — accept goes
  through the polymorphic `POST /invitations/:id/accept`, then re-reads `GET /auth/me` so "My kids" appears at
  once) and labels team invitations addressed to a child "For <child>" / "Accept for <child>"; `/invite/[token]`
  and `web/app/invite/[token]` branch on `invitation.kind === 'guardian'` (child / relationship / team rows, same
  accept call). Coach side: `teams/[id]/players` roster cards for **managed** players get an "Invite a parent"
  action → `app/teams/[id]/players/[playerId]/guardians.tsx` (guardians + pending invites, email + relationship
  chips, remove; invite/remove-others need `canManageRoster`, a guardian gets **Leave** on their own row). Hooks:
  `hooks/useGuardians.ts` (`usePlayerGuardians`, `useInviteGuardian`, `useRemoveGuardian` — invalidate the guardian
  list + team detail, invites also `invitationKeys.all`). Accounts created by a guardian invite carry
  `name = email local part` and get the one-time display-name prompt — see "Display names" below (the prompt is
  no longer guardian-specific). Tests:
  `__tests__/utils/guardian.test.ts`, `__tests__/hooks/useGuardians.runtime.test.tsx`,
  `__tests__/app/{game-detail-rsvp-picker,invitations-guardian,profile-my-kids}.test.tsx`. Maestro:
  `.maestro/guardian-rsvp.yaml` (Sonya Curry = seeded MOTHER of Steph Curry with no staff row, Warriors "vs Lakers" game; Dell Curry is also Steph's FATHER but is seeded as **Warriors Team Manager**, so he sees Start Game / Continue Tracking and is not a pure-guardian fixture).
- **Display names.** `syncUser` falls back to `name = email local part` when WorkOS supplies no first/last
  name (plain AuthKit sign-ups as well as guardian-invite accounts), so
  `utils/role-onboarding.ts#hasPlaceholderName(user)` (name === email local part, case-insensitive) is the
  placeholder signal — it replaced the guardian-gated `utils/guardian.ts#needsDisplayName`. `postLoginRoute`
  sends **any** placeholder-named account to `app/onboarding/name.tsx` once (`needsNamePrompt`, flag
  `nameAsked:<userId>`; the role step, whose `finish` re-resolves `postLoginRoute`, still wins) →
  `PATCH /auth/me { name }`; Skip keeps the placeholder and never asks again. The same screen doubles as the
  editor behind Profile → Account → **Name** (`/onboarding/name?from=profile`: pre-fills a non-placeholder
  name, Save pops back, Cancel discards — same back-vs-replace rule as `onboarding/role`). Tests:
  `__tests__/utils/role-onboarding.test.ts`, `__tests__/app/onboarding-name.test.tsx`; Maestro
  `.maestro/profile.yaml` renames Frank Vogel and **reverts** (team-staff.yaml asserts the seeded name).

#### Mobile API errors, permissions & toasts
- `services/api-client.ts` registers an error-normalizing response interceptor **before** the 401/refresh
  interceptor. For any response with a JSON body it copies the server's `error` (or `message`) onto
  `error.message`, the server `code` onto `error.code`, and the whole body + `status` onto `error.apiError`.
  The existing `error instanceof Error ? error.message : fallback` sites therefore show the real reason
  (e.g. the FREE-tier team cap) instead of "Request failed with status code N". Helpers:
  `getApiErrorMessage(err, fallback)` and `isUpgradeRequiredError(err)` (402 or `code === 'upgrade_required'`).
  Network errors keep axios' own `code` (`ECONNABORTED`, …).
- `hasTeamPermission(team, userId, permission, userRole?, leagueAdminOf?)` returns `true` for a system `ADMIN`
  regardless of staff rows and for an admin of the team's league (mirrors `backend/src/utils/permissions.ts`).
  Pass `user?.role` and `user?.leagueAdminOf` from the auth store (see "Mobile permission gating").
- Local user edits (avatar, role) go through `auth-store.updateUser(patch)`; `setUser` is for login only
  (it fires `USER_LOGGED_IN` analytics and `identifyUser`).
- Jersey numbers: `0` is a valid number — always test `jerseyNumber != null`, never truthiness.
- `components/Toast.tsx` renders toasts as a flowing column under the safe-area inset (newest at the bottom,
  at most `MAX_VISIBLE_TOASTS = 3`, oldest dropped) so concurrent toasts stack instead of overlapping.

### Socket.io (Live Game Broadcast)

Real-time game updates use Socket.io with an in-memory adapter. Single-replica
only — see `backend/src/index.ts` for the multi-replica startup guard and
issue #26 for the Redis adapter follow-up.

| Direction       | Event                | Payload                                                        |
| --------------- | -------------------- | -------------------------------------------------------------- |
| client → server | `join-game`          | `{ gameId }` (ack with success/error)                          |
| client → server | `leave-game`         | `{ gameId }`                                                   |
| server → client | `game-snapshot`      | `{ game, events }` (on join / rejoin)                          |
| server → client | `game-event`         | `{ event, score }` (on persist; score is **post-insert**)      |
| server → client | `game-event-removed` | `{ gameId, eventId, score }` (on delete/undo; post-delete score) |
| server → client | `game-score-change`  | `{ gameId, score }` (on `PATCH /games/:id` score edits)        |
| server → client | `game-status-change` | `{ gameId, previousStatus, status, score }` (on transition)    |

`score` is always `{ homeScore, awayScore }`. Every broadcast carries the
current score so a client can drop events and still converge.

- Handshake auth: bearer token via `socket.handshake.auth.token` (or
  `Authorization` header). Checked once at connect; see `authenticateSocket`.
- Rate limits (audit #16, `websocket/rate-limit.ts` — in-memory, single-replica like the adapter):
  handshake attempts 60/min per IP, checked **before** auth so connect spam never reaches JWKS/DB;
  max 50 concurrent sockets per IP; `join-game` 20/min per socket (ack `code: 'rate_limited'`).
  A limited handshake rejects with `connect_error: Rate limited`, which mobile `services/socket.ts`
  backs off and retries exactly like `Service unavailable`. The IP key is the rightmost
  `x-forwarded-for` entry (the ALB-appended hop, same trust rule as `trust proxy: 1`), falling back
  to the peer address.
- Room naming: `game:<gameId>` (see `GAME_ROOM_PREFIX` / `gameRoom()`).
- Snapshot cap: `SNAPSHOT_EVENT_LIMIT = 100` most-recent events returned on
  join, in chronological order.
- Handshake rejection recovery (mobile `services/socket.ts`, audit #17b): a
  middleware rejection arrives as `connect_error` and socket.io does **not**
  auto-reconnect from it. `Unauthorized` → refresh via the api-client's
  single-flight `refreshAccessToken()` then `socket.connect()` (the `auth`
  callback reads the new token), max `MAX_AUTH_REFRESHES` (2) in a row; a
  rejected refresh token is left to the next REST 401 to log out. `Service
  unavailable` (backend cannot reach JWKS) → exponential back-off
  (2s·2ⁿ, max `MAX_UNAVAILABLE_RETRIES` = 5). A successful `connect` resets
  both budgets; `resetSocket()` cancels any pending retry. `useLiveGame`
  reports `reconnecting` while `isSocketRecovering()` and `error` otherwise.

### Stats (finalized box scores & season aggregates)

- `StatsService.finalizeGameStats(gameId)` (`backend/src/services/stats-service.ts`) recomputes a game's
  box score from `GameEvent`s and upserts `PlayerStats` (one row per player) and `TeamStats` (one row per
  game). It runs when a game is `PATCH`ed to `FINISHED` **and** whenever an event is created or deleted on a
  game that is already `FINISHED` (`GameEventService` → `StatsService.refinalizeIfFinished`; post-finish
  edits are allowed, not rejected — the stored box score just follows them). It is idempotent: `PlayerStats`
  rows for players with no remaining events are deleted, and a game with **no** player events ends up with no
  `PlayerStats`/`TeamStats` rows at all.
- **Tracked vs. finished games.** `GET /api/v1/stats/teams/:teamId` returns `gamesPlayed` (all `FINISHED`
  games = `wins + losses`, score-based) and `trackedGames` (finished games that have a `TeamStats` row).
  Per-game averages divide by `trackedGames`, so a game created directly as `FINISHED` with a score but no
  events (or finished with no events) counts in the record but does not deflate PPG/RPG/APG. Player season
  averages already divide by the player's own `PlayerStats` row count.
- `TeamStats` stores **raw shooting counts** (`fieldGoalsMade/Attempted`, `threePointersMade/Attempted`,
  `freeThrowsMade/Attempted`; FG includes 3P, matching `PlayerStats`) plus the per-game percentages.
  Season percentages in `GET /api/v1/stats/teams/:teamId` are **Σmade / Σattempted** across finalized games,
  never a mean of per-game percentages (a 1/1 game then a 1/9 game reads 20.0%, not 55.6%). Games with zero
  attempts contribute nothing to the denominator. The migration
  `20260822120000_team_stats_shooting_counts` backfilled existing rows from their `PlayerStats`.
- Use the exported `shootingPercentage(made, attempted)` helper (1 decimal, `0` when nothing attempted)
  rather than inlining the rounding.
- **Ties.** Equal scores are a `'T'`, never a loss: the season record is `{ wins, losses, ties }`
  (`gamesPlayed = wins + losses + ties`) and `recentGames[].result` is `'W' | 'L' | 'T'` (`gameResult()` in
  `stats-service.ts`). Mobile derives outcomes only through `mobile/utils/game-result.ts`
  (`getGameResult`, `getResultColor` — T is neutral `textSecondary`, `formatRecord`); never compare
  `homeScore > awayScore` inline in a screen. Screens show the tie count only when it is non-zero.

### Game score (server-derived, audit #6/#8/#38)

- `Game.homeScore` is **derived from the event log**: `GameEventService.createEvent`
  / `deleteEvent` recompute it from made `SHOT` events (`metadata.points || 2`,
  same rule as `StatsService`) inside the same Prisma transaction as the
  insert/delete, after a `SELECT … FOR UPDATE` on the game row so concurrent
  shots can't race to an undercount. Both endpoints return the post-change
  `score` (`POST /games/:id/events` → `{ event, score }`,
  `DELETE /games/:id/events/:eventId` → `{ success, score }`) and broadcast it.
- `PATCH /games/:id { homeScore }` is honoured **only while the game has no
  SHOT events** (score entered for a game not tracked in-app). Once shots
  exist the client value is ignored and the derived score re-persisted (old
  clients keep working; under-counted games self-heal on their next PATCH).
  `awayScore` is always client-supplied (opponent points).
- Mobile tracker (`app/games/[id]/track.tsx`) never sends `homeScore`; it
  renders `game.homeScore` from the detail cache, which
  `useCreateGameEvent`/`useDeleteGameEvent` update from the response score.
- **Undo targets the created event (audit #7/#77/#76):** `recordEvent` returns
  a `LocalEvent`; once the create resolves the screen calls
  `confirmEvent(localId, event.id)` which attaches `serverId`. The
  `UndoBanner` is rendered `pending` (button disabled, countdown held, label
  "SAVING…") until then, and is `key`ed by `localId` so the 5s countdown
  restarts per event. `handleUndo` deletes `lastEvent.serverId` — never
  `events[0]` from the TanStack cache. A failed create calls
  `discardEvent(localId)`. Invalidate event lists with
  `gameEventKeys.listsFor(gameId)` (`list(gameId)` ends in `undefined`, which
  TanStack's partial matcher does not treat as a wildcard).
- **Spectator snapshot merge (audit #73):** `useLiveGame` merges a
  `game-snapshot` with the events already in state by id (streamed-but-not-
  in-snapshot events stay at the top and their score wins) instead of
  replacing, so an event broadcast while the server was building the
  snapshot isn't lost.
- **Hot-streak / milestone counters (audit #75):** `game-tracking-store`
  counters are derived = `seedCounters` (folded once from the server's event
  page via `seedFromEvents` when the tracker opens) + remaining local events.
  `undoLast`/`discardEvent` re-fold, so undoing a miss restores the streak
  and undoing a rebound/assist reverts the double-double math. Seeding never
  toasts. The seed is bounded by the 100-event page the tracker loads.
  **Free throws** (SHOT with `points: 1`, the "FT" row in `ShotButtons`) never
  touch `playerStreaks` in either direction — a made FT doesn't extend a hot
  streak, a missed FT doesn't reset one — but made-FT points do count toward
  `playerPoints` (10/20-point milestones and double-doubles include them).

### Entitlements / Feature Gating

**Mobile has no entitlement UI (decision 2026-08-23).** `FeatureGate`, `UpgradePrompt` and `store/entitlements-store.ts` were dead code (never rendered/fetched) and were removed; the app exposes no entry point for the PREMIUM-gated features (team CSV export, calendar subscribe). The backend gates stay as the single source of truth. The only tier feedback users see is the 402 `upgrade_required` message on team create (`UsageMeter` on Profile still shows FREE-tier usage). Re-add a client layer together with a real purchase flow when monetisation is scheduled.

Subscription feature gating has a **single source of truth**:
`backend/src/services/entitlements/index.ts`. It owns the `Feature` enum, the
feature->tier map (FREE / PREMIUM / LEAGUE), usage limits, and the
`FREE_TEAM_LIMIT` constant (3). Do not redefine tier rules elsewhere — import
from there (issue #43's usage metering reuses these constants).

Enforcement lives in `backend/src/api/middleware/entitlements.ts` (the only entitlement middleware —
the old unmounted `requireFeature` / `requireUsageLimit` in `api/auth/middleware.ts`, which answered
403, are gone):

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
- **League admins (decision 3)**: `POST /leagues/:id/admins { userId }` (201, `userId` must be a UUID)
  and `DELETE /leagues/:id/admins/:userId` (404 if not an admin) are **system-ADMIN-only** — an existing
  league admin can no longer grant the role to others (`LeagueService.addLeagueAdmin` was tightened to
  match `removeLeagueAdmin`; revisit if delegated league administration becomes a product decision).
  The session user payload on `GET /auth/me`, `GET /auth/callback` and `POST /auth/dev-login` carries
  `leagueAdminOf: string[]` (league ids from `LeagueAdmin` rows, sorted; empty for most users, and **not**
  populated for system ADMINs, who are implied admins of every league via `role === 'ADMIN'`).
- **Global role is never an access check.** The self-selectable `User.role` (`COACH` / `PLAYER`) is
  only read by services to (a) short-circuit for `ADMIN` and (b) allow team creation. Everything
  "on behalf of another player" goes through `utils/permissions.ts#getPlayerTeamAccess(userId, playerId)`
  → `{ memberTeamIds, manageableTeamIds }` (teams the player is on / the subset the caller has
  `canManageRoster` on). `requireRole`, `requireFeature` and `requireUsageLimit` were removed from
  `api/auth/middleware.ts` — they were unmounted and contradicted the 402 entitlement contract.
- **Managed players (role matrix B2.10)**: `PATCH/DELETE /players/:id` for a managed player requires
  the caller to be its `managedById` **and** currently have `canManageRoster` on a team the player is
  rostered on, or — so create-then-edit works — the player is on no team yet and was created < 24h ago
  (`MANAGED_PLAYER_GRACE_MS`). A creator who has left the roster loses edit/delete/email rights; system
  ADMINs are unaffected. Consequence: deleting an un-rostered managed player older than 24h is admin-only.
- **Teams** (`team-service.ts`): `listTeams` always ANDs the caller's access clause (staff OR member OR
  league admin of the team's league) with any `seasonId` / `leagueId` / `playerId` filter — only system
  ADMINs skip it. `PATCH /teams/:id { seasonId }` moving a team into a different season requires
  `isLeagueAdmin` on the **target** season's league (in addition to `canManageTeam`), otherwise 403.
  `GET /teams/:id` includes `members[].player.email` only for callers with `canManageRoster`
  (head/assistant coach, league admin, system admin); players and stats-only staff get `{ id, name }`.
  Staff emails stay in the payload for every team member (coach contact info).
- **Games** (`game-service.ts`): `updateGame` runs `canAccessTeam` **before** any field-specific branch
  (403 `You do not have access to this game` for unaffiliated users, regardless of body) and rejects a
  body with no updatable fields (`updateGameSchema` `.refine` → 400 `At least one field must be provided`;
  the service also throws `BadRequestError('No fields to update')` as defense in depth). Changing `status`
  or a score on a `FINISHED` game requires `canManageRoster` (head/assistant coach, league admin, system
  admin) — a `canTrackStats`-only Team Manager can no longer reopen or rewrite a final. `listGames`
  includes teams the caller administers via the league (same set as `canAccessTeam`). Lane D owns the
  socket emit block at the bottom of `updateGame`; keep authz edits at the top of the function.
  `GET /games/:id` (`GameDetailView`) and `GET /games/:id/rsvps` (`RsvpView`) apply the team-detail
  email rule (role matrix B2.5): `team.members[].player.email` / `rsvps[].user.email` only for callers
  with `canManageRoster` (RSVP keeps the caller's own row intact); staff emails stay. `listGames` uses
  `GAME_LIST_INCLUDE` (no people at all).

### Team Invitations & Unified Add Player (roster/invite unification)

Spec: `docs/plans/roster-invite-unification-spec.md` (TeamSnap-style Add Player; decisions D1–D5 +
eng-review amendments recorded there).

- **`POST /teams/:teamId/players`** (gate `canManageRoster`) is the unified Add Player call —
  name required, `playerEmail?`, `guardianEmail?` + `guardianRelationship?`, jersey/position/photo.
  It supersedes both `POST /teams/:id/managed-players` and the `{name,email}` arm of
  `POST /teams/:id/invitations` (both stay mounted for old clients; remove after OTA adoption).
  The path previously answered 410 — that tombstone was deleted deliberately. Consent model:
  - **Case 1** (no email): managed `User` + `TeamMember`, one transaction. `rostered: true`.
  - **Case 2** (email with no *claimed* account — includes reusing an **unclaimed** pre-provisioned
    row, `workosUserId` null; `managedById` set only if null, name/role never touched): managed
    `User` (`isManaged: true`, `managedById` = coach — deliberate authz statement, B2.10 edit
    rights until claim) + `TeamMember` + `TeamInvitation` in one transaction, "added" email copy.
    **The player is on the roster immediately**; accept only activates their login.
  - **Case 3** (email belongs to a claimed account, `workosUserId` set): invitation **only** —
    membership on accept (pre-consent membership = de facto auto-accept, deferred by D2).
    `rostered: false` in the response; `guardianEmail` is refused with `guardianInvited: false` +
    reason (guardian system requires membership).
  - Unique-email races: `user.create` P2002 is caught and retried once against the winner row
    (both the unified endpoint and the deprecated create-and-invite arm, which also sets the
    managed flags now).
  - Response: `{ rostered, invited, member, invitation, guardianInvited, guardianReason?, emails:
    { player?, guardian? } }` — **per-send email flags**; a failed SES send returns `false` and the
    client must warn the coach (silent failures were invisible — SES-sandbox incident 2026-08-28).
    `POST /teams/:id/invitations` and the guardian invite route likewise return `emailSent`
    (`null` = no address). Invitation emails are **awaited** (logged + reported, never thrown).
- **Invite-status chips:** `GET /teams/:id` joins `invitations` with `status IN (PENDING,
  ACCEPTED)` (`id, playerId, status, expiresAt, createdAt` — never `token`), stripped to `[]` for
  callers without `canManageRoster` (same rule as member emails). Chip derivation: Active =
  `player.isManaged === false` (claimed via login) **or** latest invitation ACCEPTED (web-link
  accepters never clear `isManaged`); Invited = PENDING unexpired; Invite expired = PENDING past
  `expiresAt` (client-computed); Not invited = everything else. Existing-account pending invites
  (case 3, no member row) render client-side from `GET /invitations?teamId=`, deduped against
  `members[]` by `playerId`.
- **Resend = supersede:** `POST /teams/:id/invitations { playerId, supersede: true }` expires the
  live PENDING row and creates a fresh one (new token — the old link dies) in the same code path
  as create. The superseding row **inherits `jerseyNumber`/`position`/`message` from the row it
  expires** when the request omits them (mobile Resend sends only `{ playerId, supersede }`) —
  a case-3 accept creates the member row from the live invitation, so a bare resend must not wipe
  the coach-set jersey (jersey-loss fix 2026-08-29); explicit values still win. With `supersede` an existing **member** is allowed (a rostered case-2 player);
  a claimed account that is already a member answers 400 `Player already has access to this team`.
  Resend/"Invite" actions must only target PENDING rows client-side. Expiry-check and insert are
  not one transaction, so a lost create race on the partial unique index (double-tap resend) maps
  P2002 → 400 `A pending invitation already exists for this player` (`createInvitationRow`), never 500.
- **Accept tolerates existing membership:** both accept paths use `teamMember.upsert`
  (create-if-missing, `update: {}` — coach-set jersey/position never overwritten). The old
  "You are already on this team" 400 on accept is gone. Race rules (`transitionPending`,
  audit #58) unchanged.
- **Rejection strips the unclaimed email (consent, spec T1 as narrowed by ship review):** only
  the invitee's explicit REJECTED transition nulls `User.email` (guarded: `workosUserId` null and
  no other PENDING **or ACCEPTED** invitation references the player) — otherwise `syncUser`'s
  claim-by-email turns a later, unrelated sign-up into silent team membership. The roster entry
  survives (D1). **Deliberately not stripped** on CANCEL (a coach's action must not destroy
  coach/admin-entered emails; re-inviting would orphan the row into a duplicate account) or on
  EXPIRY (resend needs the address; the invite email already informed that mailbox).
- **Email matching is case-insensitive and new accounts store lowercase** (red-team RT1):
  WorkOS normalizes to lowercase and `syncUser` claims by exact match, so all invite/add flows
  look up with `mode: 'insensitive'` and create with `trim().toLowerCase()` — a mixed-case entry
  must never create an unclaimable duplicate or bypass the case-3 consent branch.
- **Supersede is atomic** (red-team RT2): `createInvitationRowSuperseding` expires the live
  PENDING row and creates its replacement in ONE transaction (an ACCEPTED row appearing in the
  window → 400, never a chip regression); a superseding resend for a rostered case-2 player uses
  the "added" email variant. The case-2 managed-flags write is claim-guarded
  (`updateMany WHERE workosUserId IS NULL`; zero rows → the add re-branches to case 3, RT4).
- The `GET /teams/:id` invitations join carries **rostered players only** (case-3 invites come
  from `GET /invitations?teamId=` client-side, per the spec), newest-first with a `take: 200`
  guard. Awaited invite/guardian email sends are bounded at 5s (`utils/promise-timeout.ts`) so
  routes stay under the mobile client's 10s timeout.
- The invitation email template branches on `variant`: `'added'` (cases 1-2, "You've been added…
  activate your access") vs default "invited to join" (case 3 + deprecated arm).
- `POST /teams/:id/invitations` (staff with `canManageRoster`) creates a `TeamInvitation` with a random
  `token` and emails the player a `capyhoops.com/invite/<token>` link. The token is a **bearer secret**:
  `POST /invitations/by-token/:token/accept` is unauthenticated and accepts on behalf of the invited player.
- **The token is never returned on an authenticated response** (audit #14). `invitation-service.ts` reads
  invitations back through explicit `select` constants (`INVITATION_SCALAR_SELECT` / `INVITATION_SELECT` /
  `INVITATION_TEAM_SELECT`) that omit `token`, and `api/invitations/serializers.ts#omitToken` strips it again
  at the route layer as defense in depth. Only `getInvitationByToken` / `acceptInvitationByToken` (the
  public routes, where the caller already holds the token) touch it. Tests in `tests/api/invitations.test.ts`,
  `tests/api/teams.test.ts` and `tests/services/invitation-service.test.ts` assert `token` is absent from
  create/list/get/accept/reject/cancel. Do not add `include`-based invitation queries.
- **`GET /invitations?playerId=<other user>`** (role matrix B2.4): allowed for system ADMINs (unscoped);
  with `teamId`, for callers with `canManageRoster` on that team; without `teamId`, for callers with
  `canManageRoster` on at least one team the player is rostered on — results are then scoped to those
  teams (`teamId: { in: manageableTeamIds }`). Everyone else gets 403. The old check (`user.role ===
  'COACH'`, a self-selected role) let any user enumerate anyone's invitations.
- **Lifecycle (audit #22/#23/#58).** Uniqueness is a hand-written **partial** unique index
  `TeamInvitation_pending_teamId_playerId_key ON (teamId, playerId) WHERE status = 'PENDING'` (migration
  `20260823060000_partial_unique_pending_invitation`; Prisma can't express it, so `schema.prisma` carries a
  comment and a plain `@@index([teamId, playerId])` instead of `@@unique`). Any number of
  REJECTED/CANCELLED/EXPIRED rows may pile up per team/player, so invite → reject → re-invite works.
  Nothing schedules `expireOldInvitations`; expiry is **lazy**: `createInvitation` treats a PENDING row whose
  `expiresAt` has passed as non-blocking and flips it to EXPIRED before creating the new one, and accept
  paths flip it on contact. State transitions out of PENDING go through `transitionPending()` —
  `updateMany … where { id, status: 'PENDING' }` inside the transaction — so the loser of a concurrent
  accept gets **400** "no longer pending" instead of a P2002 500 from the `TeamMember` insert.
  `GET /invitations?teamId=` lists **all** of the team's invitations for staff with `canManageRoster`;
  other callers with team access (rostered players) remain scoped to `playerId = caller`.
- **Create-and-invite (audit #69).** `POST /teams/:id/invitations` accepts **either** `{ playerId }` or
  `{ name, email, profilePictureUrl? }` (never both — `createInvitationSchema` `superRefine`). With an email:
  an existing account with that email is reused (so a retry or a self-signed-up player just works);
  otherwise the `User` (`role: PLAYER`, unverified) and the `TeamInvitation` are created in **one
  `$transaction`**, so a failed invite never leaves an orphan player. Mobile now uses the unified
  `POST /teams/:teamId/players` instead (this arm stays mounted for pre-unification builds).
- **Public route rate limit (audit #36).** `GET /invitations/by-token/:token` uses `invitationTokenRateLimit`
  (30 / 15 min, keyed by **token** via `invitationTokenKey`) because `capyhoops.com/invite/<token>` is
  rendered server-side and every lookup arrives from the web server's single egress IP. The accept `POST`
  stays on the IP-keyed `writeRateLimit` (the browser calls it directly).
- Mobile expiry copy comes from `utils/invitation-expiry.ts` (`formatInvitationExpiry` /
  `isInvitationExpired`, timestamp compare — no `Math.ceil` → `-0` "Expires today" on a dead invite, #59).

### Guardians / PARENT role (`services/guardian-service.ts`)

Spec: `docs/plans/parent-role-spec.md` (role-matrix decision 1). A guardian is an adult `User` linked to one or
more child players through `Guardian { parentId, childId, relationship, isPrimary }`; exactly one link per
child is `isPrimary` (the first one; the oldest remaining link is promoted when the primary is removed).
Removing the last guardian never deletes the child.

- **Roles.** `UserRole.PARENT` is *derived*, never self-selectable (`PATCH /auth/me/role` still rejects it).
  A brand-new account created through a guardian invite is `PARENT` (unverified email, **not** `isManaged`).
  An existing account keeps its role — a coach who is also a parent stays `COACH`; a bare `PLAYER` (no
  `TeamMember`, no `TeamStaff` rows) is promoted to `PARENT` on accept. `syncUser` is unchanged: the
  guardian-created row is claimed by email on first WorkOS login like any pre-provisioned row.
- **Link flow.** `POST /teams/:teamId/members/:playerId/guardians { email, relationship }`
  (`canManageRoster`; `relationship` ∈ `GuardianRelationship` MOTHER/FATHER/GUARDIAN/OTHER) finds-or-creates
  the adult's `User`, creates a PENDING `GuardianInvitation` (7-day expiry) and emails
  `${PUBLIC_APP_URL}/invite/<token>` via `guardianInvitationTemplate`. Same token rules as team invites: the
  token is a bearer secret, read back only through `GUARDIAN_INVITATION_SELECT` (no `token`) and stripped
  again by `omitToken`. Uniqueness is the hand-written partial index
  `GuardianInvitation_pending_childId_invitedEmail_key … WHERE status = 'PENDING'` (migration
  `20260823120000_guardian_invitation`); a stale PENDING row is flipped to EXPIRED on re-invite.
- **Accept.** The public routes are polymorphic: `GET /invitations/by-token/:token` returns
  `invitation.kind: 'team' | 'guardian'` (guardian view: `childName`, `teamName`, `inviterName`,
  `relationship`, `status`, `expiresAt`) and `POST /invitations/by-token/:token/accept` returns
  `{ kind: 'guardian', invitation, guardian }` — acceptance creates the `Guardian` row inside one
  `$transaction` guarded by `updateMany … WHERE status = 'PENDING'` (loser of a race gets 400).
  Authenticated `POST /invitations/:id/accept|reject` try the id as a `GuardianInvitation` first and require
  the caller's email to match `invitedEmail` (403 otherwise); responses carry `kind` too.
- **Other guardian routes.** `GET …/guardians` → `{ guardians: [{ id, userId, name, email?, relationship,
  isPrimary, createdAt }], pendingInvitations }` (roster managers or the child's guardians; `email` only for
  roster managers). `DELETE …/guardians/:guardianUserId` (roster manager, or the guardian removing themself).
- **What a guardian can do.** `utils/permissions.ts`: `isGuardianOf(userId, childId)`,
  `isGuardianOfTeamMember(userId, teamId)`; `canAccessTeam` is true for a guardian of any current member and
  `getTeamPermissions` returns `canViewStats: true` only (so schedule, live games, box scores, season stats —
  the member read set; roster emails stay stripped; no stat tracking / roster / announcements → 403).
  `POST /games/:id/rsvp { status, playerId? }` — `playerId` is allowed when the caller is a guardian of that
  player and the player is rostered on the game's team; the `GameRsvp` row is keyed on the **player** and the
  confirmation email goes to the guardian. Team invitations addressed to a child may be accepted/rejected by
  a guardian, `GET /invitations` default scope includes the caller's children, and `listInvitations?playerId=`
  accepts a child id. `NotificationService.sendToTeam` adds guardians of members (deduped). `PATCH
  /players/:id` lets a guardian change the child's `name` / `profilePictureUrl` (not `email`; jersey stays on
  the coach-only team-member route). `GET /auth/me`, `/auth/callback` and `/auth/dev-login` add
  `user.guardianOf: { childId, childName, relationship, isPrimary }[]`.
- **List scoping (mobile PR).** `TeamService.listTeams` and `GameService.listGames` add
  `{ members: { some: { playerId: { in: childIds } } } }` (via `GuardianService.getChildIds`) to the caller-access
  `OR`, so a guardian's Teams / Games / Home tabs show the children's teams. `GET /invitations` (no `teamId` /
  `playerId`, status unset or `PENDING`) also returns `guardianInvitations: PublicGuardianInvitation[]` — the
  caller's pending, unexpired `GuardianInvitation`s matched on `invitedEmail` case-insensitively
  (`GuardianService.listPendingForUser`), no token — which the mobile Invitations tab renders as "Accept for <child>".
- Tests: `tests/services/guardian-service.test.ts`, `tests/api/guardians.test.ts`,
  `tests/utils/permissions.test.ts`, `tests/schemas/guardian.test.ts`, guardian cases in the rsvp /
  invitation / notification / player-service / auth suites. Out of scope (v1): claim-by-code, parent-to-parent
  invites, `respondedBy` on RSVPs.

### Player directory (`/api/v1/players`)

`PlayerService.listPlayers(params, caller)` / `getPlayerById(id, caller)` take the authenticated caller (`{ id, role }`) and scope by it (audit #3):

- **ADMIN**: unscoped; may filter by `role` / `isManaged`; `search` matches name *or* email; `email` is included.
- **Everyone else**: only themselves plus users who share a team with them (teams they play on or are staff of); `role` / `isManaged` filters are ignored (always `PLAYER`, non-managed); `search` matches name only; `email` is omitted from list results and is `null` on detail unless it's the caller's own record. Players outside the caller's teams are a **404**, not a 403, so ids can't be enumerated.
- Team rosters (`GET /teams/:id`) remain the place coaches see their managed players; `USER_SUMMARY_SELECT` now includes `isManaged` so clients can label roster-only players (audit #64).

### Redis (`utils/redis.ts`)
Best-effort cache only — every helper fails open. The ioredis `retryStrategy` (`redisRetryDelay`) never returns `null`: it backs off 200 ms → 30 s and keeps reconnecting for the life of the process; if the connection ends anyway (`quit()`), the client is dropped and recreated lazily on next use (audit #50). Commands still fail fast while disconnected (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`).

### Avatar uploads (`services/upload-service.ts`, `api/uploads/`)
`POST /api/v1/uploads/avatar-url { contentType, contentLength? }` returns a **presigned S3 POST** (`{ uploadUrl, fields, imageUrl }`), not a PUT URL — a presigned PUT can't bind `Content-Length`, a POST policy can. The policy enforces `content-length-range` 1..`MAX_AVATAR_BYTES` (5 MB) and pins `Content-Type`; `contentLength` is an optional early 400. Mobile `services/upload-service.ts` posts a multipart form (policy fields first, `file` part last) and **throws on `!res.ok`** so a failed upload never persists a dangling URL (audit #39). When a profile's `profilePictureUrl` changes, `deletePreviousAvatar(old, new)` best-effort deletes the replaced object if it lives in our bucket (WorkOS photo URLs are never touched) — call it from any new path that sets `profilePictureUrl` (audit #61). `infra/s3.tf` allows `POST` in CORS and aborts incomplete multipart uploads after 1 day.

### Environment URLs & time zone
- `API_BASE_URL` — the host that serves `/api/v1/*` (`https://api.capyhoops.com` in prod via `infra/ecs.tf` + `infra/task-definition.json`; default `http://localhost:3000`). Used for the calendar feed/webcal URLs. `PUBLIC_APP_URL` stays the web apex (`https://capyhoops.com`) for human-facing links (invite pages, "View game"). They were conflated before (audit #24) — feeds pointed at the apex, which serves no API.
- `DEFAULT_TIMEZONE` — IANA zone used to format dates in outbound email (`utils/format-date.ts#formatEmailDate/formatEmailDateTime`; default `America/Los_Angeles`). Never call `toLocaleDateString()` bare in a template variable — ECS runs in UTC (audit #57). Teams/leagues have no time-zone column yet; pass one through the helper's `timeZone` arg once they do.

### Calendar feed (`services/calendar-service.ts`, `api/teams/calendar.ts`)
- `resolveToken` checks, on **every** fetch: token exists, not revoked, team matches, user still has team access, and the user's *current* effective tier still includes `CALENDAR_SYNC` (system ADMINs bypass) — a downgraded/expired subscription stops the feed with 403 instead of serving forever (audit #43).
- The calendar router is mounted on `/teams` ahead of the main teams router so the public `GET /teams/:id/calendar.ics` skips auth. Because of that ordering, `authenticate` is attached **per route** to `subscribe`/`revoke` — never `router.use(authenticate)` there, or every `/teams/*` request verifies the JWT twice (audit #71).

### Push notifications (`services/notification-service.ts`)
`sendMessages` inspects Expo tickets immediately and schedules `checkReceipts()` ~15 min later (unref'd timer); any ticket/receipt with `DeviceNotRegistered` deletes that `PushToken` (`pruneDeadTokens`). Other receipt errors are logged only (audit #60). The jest mock in `tests/__mocks__/expo-server-sdk.js` stubs both the send and receipt APIs.

### Transactions (audit #70)
`TeamService.addManagedPlayer` creates the managed user + team membership inside one `$transaction` so a failed second insert can't leave an orphan managed user (the `createTeam` half — team + roles + staff row — landed with audit #49 in `fix/infra-limits-and-reconnects`).

### Key Patterns
- Layered architecture: API routes → Services → Models (Prisma)
- Event-driven: Kafka for game events, Flink for real-time aggregation
- Real-time: Socket.io WebSocket for live game updates
- State management: Zustand (client) + TanStack Query (server state) in mobile
- Authentication: WorkOS (AuthKit). JWT is the session token format — WorkOS is the identity provider.

### Session tokens & refresh (#349)
- **Access tokens are verified locally** (`WorkOSService.verifyToken`): signature against the WorkOS JWKS for `WORKOS_CLIENT_ID` (via `jose` `createRemoteJWKSet`, cached, auto-refresh on unknown `kid`), `alg` ∈ {RS256, ES256}, and required `iss` (`WORKOS_JWT_ISSUER`, default `https://api.workos.com`), `exp`, `sub`. No WorkOS API call per request — the DB lookup by `workosUserId = sub` is the user check. Invalid/expired/forged → **401**; JWKS unreachable → **503** (`ServiceUnavailableError`), which mobile must treat as transient, not as a logout. The pre-2026-08 implementation only base64-decoded the payload (audit finding #1).
- WorkOS access tokens are **short-lived (minutes)**. `GET /auth/callback` returns both `accessToken` and a rotating `refreshToken`; `POST /auth/refresh { refreshToken }` returns a new pair — **401** only when WorkOS definitively rejects the token (4xx); **503** when WorkOS is down/unreachable and **429** (+`Retry-After`) when WorkOS rate-limits, both of which the mobile client treats as transient (keeps tokens, no logout). `WorkOSService.refreshSession()` wraps `authenticateWithRefreshToken`.
- Mobile `services/api-client.ts`: on a 401 it performs a **single-flight** refresh (concurrent 401s share one call — WorkOS invalidates the old refresh token on use), stores the new pair via `setAuthToken(access, refresh)`, and replays the original request once. Auth endpoints (`/auth/refresh`, `/auth/callback`, `/auth/login`, `/auth/dev-login`) and already-retried requests never trigger a refresh. `refreshAccessToken()` is exported and resolves to a `RefreshOutcome`: `ok` (new token stored), `rejected` (no refresh token, or `/auth/refresh` answered **401**) → `logout()`, or `unavailable` (network error, timeout, 429, 5xx/503) → tokens are **kept** and the original error is surfaced to the caller; the next 401 retries the refresh (audit #20). A 401 from an auth endpoint itself never logs out from the interceptor.
- **Where tokens live on the device (audit #52):** `auth-store` persists through `services/secure-storage.ts`, a split Zustand `StateStorage`. `accessToken` and `refreshToken` go to `expo-secure-store` (iOS Keychain / Android Keystore, `AFTER_FIRST_UNLOCK`) under two keys, `auth.accessToken` and `auth.refreshToken` (separate entries because iOS caps a SecureStore value at 2048 bytes); `user`/`isAuthenticated`/`version` stay in AsyncStorage under the unchanged `auth-storage` key with both token fields rewritten to `null`. `getItem` merges the halves back; `clearSession()` also calls `clearPersistedAuth()` so a sign-out always wipes the keychain entries. **Migration:** the first read on a binary with the native module finds tokens in the legacy AsyncStorage blob, moves them into SecureStore and scrubs the plaintext copy — the user stays signed in across the 1.1.0→1.2.0 upgrade. **Fallback:** `expo-secure-store` is a native module, so the adapter never imports the JS wrapper (it calls `requireNativeModule` at load and would crash an old binary); it probes `requireOptionalNativeModule('ExpoSecureStore')` and calls the native methods directly, degrading to the pre-#52 all-in-AsyncStorage layout when the module is absent. PKCE verifier/state (`utils/pkce.ts`) and the return-path/onboarding flags are short-lived and stay in AsyncStorage. **Runtime boundary:** the module first ships in the **1.2.0** binary (build #25); OTAs published after this land only reach 1.2.0 builds, build #24 stays on the last 1.1.0 OTA.
- `auth-store` `onRehydrateStorage` clears `isLoading` via `setState` in both the success and the error branch (corrupt storage starts the app logged out instead of stuck on "Loading…", audit #34). `app/login.tsx` clears its spinner when `AppState` returns to `active` while a browser sign-in is pending (user backed out of Safari, audit #33).
- **PKCE + `state` on the mobile sign-in (audit #5):** `app/login.tsx` calls `utils/pkce.ts#beginPkceLogin()`, which persists a random `{ state, verifier }` in AsyncStorage (`auth:pending-login`, 10-min TTL) and sends `state` + `code_challenge` (S256) on `GET /auth/login`; the backend forwards both to WorkOS (`getAuthorizationUrl(state, redirectUri, codeChallenge)`). `app/auth/callback.tsx` calls `consumePendingLogin(state)` — single-use, must match the echoed `state` — **before** any network call, then sends `code`, `state`, `code_verifier` to `GET /auth/callback`, which passes the verifier to `authenticateWithCode`; WorkOS refuses the exchange if it does not match the challenge, so an intercepted code is useless. Both query params are validated in `api/auth/schemas.ts` (`loginQuerySchema` / `callbackQuerySchema`: must travel together; RFC 7636 alphabet/length). Without `state`/`code_verifier` the backend still does a plain exchange (web redirect flow + pre-PKCE app builds) — the backend is stateless, so the CSRF check lives on the device. No native module: randomness is `expo-modules-core`'s native UUID v4 and SHA-256 is implemented in `utils/pkce.ts` (`expo-crypto` is not in the binary), so this ships as an OTA.
- `hooks/useAuthRedirect.ts` (mounted in `app/_layout.tsx`) routes to `/login` whenever `isAuthenticated` flips true→false, so a dead session can't strand the user on a tab. Cold-start routing stays in `app/index.tsx`.
- **Account type self-select (audit #9):** every WorkOS sign-up is created as `PLAYER`. `PATCH /auth/me/role { role: 'PLAYER' | 'COACH' }` (authenticated, general limiter) lets a user switch between those two; `ADMIN`/`PARENT` get 403 and `ADMIN` can never be selected. Mobile shows `app/onboarding/role.tsx` once per user after sign-in when the role is `PLAYER` (`utils/role-onboarding.ts`, flag `roleChosen:<userId>` in AsyncStorage) and again from Profile → "Change account type". `auth-store.updateUser(patch)` merges the new role without re-firing login analytics.
- Dev-login tokens (`dev_…`) have no refresh token and are only accepted when `NODE_ENV=development`.
- **Account linking** (`WorkOSService.syncUser`, audit #2/#25): resolve by `workosUserId` first; then by `email` **only** if that row has no `workosUserId` (a pre-provisioned/managed row) — linking sets `workosUserId`, clears `isManaged`/`managedById`, and re-checks the admin allowlist (`isAdminEmail`) so a pre-seeded row can't suppress ADMIN bootstrap. An email already bound to a *different* WorkOS identity is a **409** from `/auth/callback` (not a merge, not a 500); P2002 races map to 409 too. `name` is set only on create; `profilePictureUrl` only on create or when the local value is null — in-app edits survive re-login. `/auth/callback` returns `profilePictureUrl` in `user`.
- **Email edits**: `email` is the login identity. `PATCH /players/:id { email }` is allowed for ADMINs, and for the managing coach of a managed player only until that player signs in (`workosUserId` null); players cannot change their own email (403). `POST /players` (pre-create an account for an email) requires ADMIN or roster-managing staff (`TeamStaff` role with `canManageRoster`, or a league admin) — 403 otherwise; roster-only players still go through `POST /teams/:id/managed-players`.
- **Self profile** (audit #10): `PATCH /auth/me { name?, profilePictureUrl? }` (authenticated, any role; `''` clears the avatar; email/role not editable here) returns `{ success, user }` with `profilePictureUrl`; `GET /auth/me` includes `profilePictureUrl` too; a replaced avatar object is removed from S3 best-effort via `deletePreviousAvatar` (audit #61). Mobile Profile uses `hooks/useProfile.ts#useUpdateProfile` (merges into `auth-store` via `updateUser`) — never `PATCH /players/:id`, which only accepts PLAYER rows and 404s for ADMIN/COACH.
- **Logout** (audit #51): `POST /auth/logout` (authenticated, no body) revokes the WorkOS session named by the token's `sid` claim via `WorkOSService.revokeSession`, which invalidates the bound refresh token. Responds `200 { success: true, revoked: boolean }` — `revoked: false` for dev tokens, tokens without `sid`, or a WorkOS outage (reported to Sentry); the client must clear local tokens regardless. `DELETE /auth/push-token` only deletes tokens owned by the caller (audit #47); call it *before* `/auth/logout` while the access token is still valid.
- **Mobile logout sequence** (audit #17/#18/#19/#41/#62): `auth-store.logout()` (async) bumps the **logout epoch**, then — with the access token still stored — runs `services/session-logout.ts#runRemoteLogout()`: `DELETE /auth/push-token` for the token this device registered (`hooks/useNotifications.ts#unregisterPushToken`, tracked in module state after a successful POST) → `POST /auth/logout`; each best-effort with a 4s timeout. Then `clearSession()`: bumps the epoch again, fires logout analytics, clears the store, and runs `runLocalLogoutCleanup()` = `resetSocket()` + `queryClient.clear()` (`services/query-client.ts` now owns the QueryClient; `_layout.tsx` just provides it). `clearSession()` is synchronous and network-free — it is what the api-client calls when the session is dead (refresh rejected), so it can never recurse. The store reaches these side effects through `store/session-hooks.ts` (registered by `services/session-logout.ts`, imported for effect in `_layout.tsx`) so the store never imports the api-client. `refreshAccessToken()` captures `getLogoutEpoch()` before `POST /auth/refresh` and discards the result if it changed, so an in-flight refresh cannot resurrect a session after logout. `useNotificationSetup` is keyed on `isAuthenticated` (not the token string) and swallows registration rejections.
- The strict `authRateLimit` (20 req / 15 min / IP) applies only to `/auth/login`, `/auth/callback` and the dev endpoints; authenticated session routes (`/auth/me`, `/auth/me/usage`, `/auth/entitlements`, `/auth/push-token`) use the general API limiter.
- `/auth/refresh` has its own `refreshRateLimit` (60 req / 15 min) keyed by a SHA-256 of the refresh token (IP fallback when the body has no token), so a team on shared gym Wi-Fi can't lock each other out — every device rotates its own token (audit #21). Mobile treats a 429 from `/auth/refresh` as transient (keeps the session, retries later); only a 401 logs out.
- Sentry: `sentryErrorHandler` skips operational `AppError`s with status < 500 (`isExpectedClientError`) — an expired token is an expected outcome, not a defect. It also skips non-`AppError` throws carrying a 4xx `status`/`statusCode` (body-parser `entity.parse.failed` → 400, `entity.too.large` → 413; `clientErrorStatus()`), and the central error handler in `index.ts` answers those with that status instead of 500. 5xx and other non-`AppError` throws are still reported.
- **Push tokens (role matrix B2.9).** `PushToken` is unique on `token` (a device, not an account). `POST /auth/push-token` upserts when the token is new or already the caller's; a token bound to a **different** user is rejected with **409** (`Push token is registered to another account`) unless that binding's `updatedAt` is older than 24h (`PUSH_TOKEN_REBIND_AFTER_MS` — a leftover from a build that never unregistered), in which case it is rebound to the caller. Hand-over on a shared device is `DELETE /auth/push-token` by the owner (logout does this). `PushToken.updatedAt` was added by migration `20260823000000_push_token_updated_at`.

### Logging & Sentry redaction (audit #15/#28/#48)
- **Never log `req.originalUrl`.** `request-logger.ts` logs `loggablePath(req)`: the path with secret segments masked (`/invitations/by-token/<x>`, `/teams/:id/calendar/<x>`, `/invite/<x>` → `[redacted]`) plus a query string whose *keys* are kept and whose sensitive *values* (`code`, `state`, `token`, anything containing `token`/`secret`/`password`/`api_key`) are masked. Helpers live in `backend/src/utils/redact.ts` (`redactUrl`, `redactPath`, `redactQueryString`, `redactQueryObject`) — reuse them for any new log line that includes a URL.
- Backend Sentry (`utils/sentry.ts`): `beforeSend` redacts `request.url`, `request.query_string`, breadcrumb `data.url` and the `transaction` name with the same helpers; `beforeSendTransaction` does the same for performance transactions (`transaction`, `request.url`, `contexts.trace.data.*url*`, span descriptions/data), which bypass `beforeSend`.
- Mobile Sentry (`services/sentry.ts`): `redactUrl` masks by **value** (not only by key name) on `request.url`, `request.query_string`, breadcrumb `data.url`/`from`/`to`, and `transaction`; `beforeSendTransaction` reuses `beforeSend`.
- `SesMailer` logs `toHash` (first 12 hex of sha256 of the lower-cased address, `hashRecipient()`) at info — never the address. The full address is emitted only via `logger.debug`, which the structured logger prints solely under `NODE_ENV=development`.

### Team staff management (role matrix B2.3 / B2.7 / B2.8, decision 2)

Head Coach and Assistant Coach share the same five permission **flags**
(`canManageTeam/Roster/TrackStats/ViewStats/ShareStats`), so flag checks cannot
tell them apart. Staff management is keyed off the `TeamRole.type` enum instead
(no schema change): `utils/permissions.ts` exposes `isHeadCoach(userId, teamId)`
(HEAD_COACH-type staff row exists) and `canManageStaff(userId, teamId)` =
system `ADMIN` **or** admin of the team's league **or** head coach.

| Action | Head Coach | Assistant Coach | Team Manager | League admin / ADMIN |
| --- | --- | --- | --- | --- |
| Edit team name / chat link, roster, invitations | yes | yes | no | yes |
| Track / view / share stats | yes | yes | yes | yes |
| **Add / re-role / remove staff** | yes | no (403) | no | yes |
| **Delete team** (`DELETE /teams/:id`) | yes | no (403) | no | yes |
| **Move team to another season** (`PATCH /teams/:id { seasonId }`) | yes, **and** must admin the target league | no (403) | no | yes (target league) |
| Remove **self** from staff | yes, unless last head coach | yes | yes | n/a |

Routes (all under `/api/v1/teams/:teamId`, bearer auth, UUID params validated):

- `GET /staff` → `{ success, staff: [{ id, teamId, userId, roleId, createdAt, updatedAt, user: { id, name, isManaged, email? }, role: TeamRole }] }`. Any team member/staff/admin may read; `user.email` only for callers with `canManageRoster`.
- `GET /roles` → `{ success, roles: [{ id, teamId, type, name, description, canManageTeam, canManageRoster, canTrackStats, canViewStats, canShareStats }] }` (definitions only, no holders).
- `POST /staff { userId | email, roleType: 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER' }` → **201** `{ success, staff }`. Exactly one of `userId`/`email`; `email` looks up an **existing** user (case-insensitive) and 404s otherwise — never creates users. 400 if the user is already staff (one role per user; use PATCH). Gate: `canManageStaff`. Added user gets a push notification (`type: 'team_staff_added'`).
- `PATCH /staff/:userId { roleType }` → `{ success, staff }`. Same gate. 404 if not staff, 400 if already that role or if demoting the **last head coach**.
- `DELETE /staff/:userId` → `{ success, message }`. Gate: `canManageStaff` **or** `:userId === caller` (self-removal). 400 when the target is the last head coach (even on self-removal).

POST/DELETE call `invalidateUsage(<affected userId>)` — staff membership is what the FREE-tier team cap counts.

**Distinct-teams cap fix (B2.8):** the cap now counts DISTINCT `teamId`s via
`countDistinctStaffTeams(userId, db?)` (`utils/permissions.ts`) in
`requireTeamCreateLimit`, `TeamService.createTeam` (inside the transaction) and
`usage-service.computeCounts` — a user holding two roles on one team is one
team. (The legacy `api/auth/middleware.ts#requireUsageLimit` that counted raw
`teamStaff` rows was removed along with `requireRole` / `requireFeature`.)

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
- **End every task with a wrap-up sweep — unprompted.** Before declaring a task done, check whether the change requires updates to (a) tests — Jest, API integration, Maestro flows; (b) documentation — `CLAUDE.md`, `docs/` (including the E2E test plan), READMEs; (c) open GitHub issues — anything the change closes, unblocks, or contradicts (post a status comment or close as appropriate). Make the updates as part of the same task and report what was updated (or state explicitly that nothing needed updating). The user should never have to ask "what about tests/docs/issues?" after a change.

## Documentation Hygiene

- **Keep docs in sync with code.** When a change alters behavior, APIs, schema, env vars, commands, architecture, or operational steps, update the affected documentation in the **same change** — `CLAUDE.md`, `docs/` (architecture, runbooks, testing plans, automation), and any relevant `README`.
- **Forward-references go stale.** When you reference an unmerged PR or "incoming" work in docs, revisit it once that work lands and reword to past tense (e.g. "merged in #202", not "incoming"). Distinguish "merged to `main`" from "deployed to production" where it matters.
- A committed **Stop hook** (`.claude/hooks/check-docs-updated.sh`) prints a reminder when code files changed in the working tree without any `docs/` or `CLAUDE.md` update. It is advisory only — treat it as a prompt to confirm docs are current, not a blocker.

## Git Workflow

- Single long-lived branch: `main`. All work happens on short-lived feature branches that merge back into `main` via PR.
- Feature branches from `main`: `feature/your-feature-name`
- **Delete feature branches once merged.** After a PR merges, delete the local branch and prune remote-tracking refs: `git branch -D <branch> && git fetch --prune`. PRs are squash-merged, so `git branch -d`/`--merged` won't recognize them as merged — verify the PR state is MERGED (`gh pr list --head <branch> --state all`) before `-D`. Do this as part of landing the PR, not as a later cleanup task.
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
3. Mobile setup (custom dev client — never `npm start` / Expo Go):
   ```bash
   cd mobile && npm install
   npx expo run:ios
   ```
4. Seed test users/teams/games for dev-login: `cd backend && npx prisma db seed` (`backend/prisma/seed.ts`).
