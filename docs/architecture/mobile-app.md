# Mobile app: structure, routing, permission gating, errors

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Mobile Structure (`/mobile/`)
- **app/**: Expo Router screens (file-based routing)
- **components/**: Reusable UI components
- **services/**: API clients
- **store/**: Zustand stores (auth, user state)
- **hooks/**: Custom React hooks
- **i18n/**: Internationalization
- **docs/design-system.md**: theme tokens (colors, typography, spacing), themed components, responsive helpers and the list of mandatory shared components (`mobile/docs/design-system.md`)
- **assets/brand/**: Hooplings icon SVG masters ("Courtside Capy" capybara mark) + `render-icons.mjs`,
  which regenerates `assets/{icon,adaptive-icon,splash-icon,favicon}.png` (`node assets/brand/render-icons.mjs`
  from `mobile/`). Edit the SVGs, never the PNGs. Icon/splash changes are baked into the native binary —
  they ship with the next `eas build`, not an OTA. Brand navy `#1C2742` is also the splash and
  adaptive-icon background in `app.config.js`.

### Mobile list pagination & cache invalidation
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
  becomes `FINISHED`; `useCreateTeam`/`useDeleteTeam` invalidate `usageKeys.all` (the Profile usage meter).
- The tab bar (`app/(tabs)/_layout.tsx`) is an absolutely-positioned translucent blur overlay — content
  deliberately scrolls behind it. Every scrollable tab screen therefore sets its scroll-content
  `paddingBottom` from `hooks/useTabBarPadding.ts#useTabBarPadding()` (= `TAB_BAR_HEIGHT` 60 + bottom
  safe-area inset + `spacing.lg`); never hand-roll that padding — a too-small value leaves the last rows
  permanently trapped under the bar (the pre-fix Profile bug).

### Mobile routing & guards
- The `(tabs)` shell has no auth guard of its own. Screens reachable while logged out (the `/invite/<token>`
  deep link) must send unauthenticated users to `/login` themselves. Use `setPendingReturnPath(path)` from
  `utils/return-path.ts` before pushing `/login`; `postLoginRoute()` (used by login, the OAuth callback and
  cold start) consumes it (30-minute TTL, in-app absolute paths only) after the role-onboarding check, so the
  user lands back on the deep link.
- **Announcement threads** (#34): `/teams/[id]/announcements` lists announcements (each card opens
  its thread and shows the served `_count.replies`); `/teams/[id]/announcements/[announcementId]`
  (`hooks/useAnnouncement`, `hooks/useAnnouncementReplies.ts`) shows the announcement, the replies
  oldest first (infinite, 20 a page) and an inline composer. Sends and deletes are optimistic with
  rollback; the thread refetches on mount and pull-to-refresh (no real-time delivery). The ⋯
  `ActionMenu` with Delete renders for a reply's author and for `hasTeamPermission(…,
  'canManageTeam')`; the API is the authority. A push with `announcementId` + `teamId` (new post,
  or a reply to the user's own post) deep-links to the thread (`hooks/useNotifications.ts`,
  `notification_opened` target `announcement`). Profile → Settings → **Reply notifications** toggles
  `notifyOnReplies` through `useUpdateProfile`. Timeline rows format dates with
  `utils/relative-time.ts#formatRelativeTime`, never an inline helper. Tests:
  `__tests__/app/announcement-thread.test.tsx`, `__tests__/hooks/useAnnouncementReplies.runtime.test.tsx`,
  `__tests__/app/profile-reply-notifications.test.tsx`; Maestro `.maestro/announcement-reply.yaml`.
- Player routes: roster cards and leaderboards link to `/players/:id/stats`. There is no
  `/teams/:id/players/:playerId` or `/notifications` route — don't add links to them.
- `GET /stats/players/:id` returns **404** for a player with no team memberships; `app/players/[id]/stats.tsx`
  renders an `EmptyState` for that case ("No stats yet" for the current user) instead of an error.
- The Profile "Leagues & Seasons" entry is shown to system `ADMIN`s and to users with at least one league in
  `user.leagueAdminOf` (`utils/team-permissions.ts#canAccessAdmin`). See "Mobile permission gating" in this file.
- **Admin: leagues and seasons** (#614). Routes: `/admin` (leagues) → `/admin/leagues/[id]` (league +
  its seasons, Add Season) → `/admin/seasons/[id]` (season detail: name, league, Active/Inactive badge,
  date range, team count from `_count.teams`, team rows linking to `/teams/:id`) → `/admin/seasons/[id]/edit`
  (name, dates, `isActive` switch; `PATCH /seasons/:id` with only the fields that changed —
  `buildSeasonPatch`; a cleared date sends `null`). Guards mirror the server: every one of these screens
  uses `useAccessGuard` + `canManageLeague(user, leagueId)` (ADMIN or admin of that league; the season
  screens take the league id from the loaded season, so an unaffiliated caller sees the API's 404 as an
  `ErrorState` instead); the league and season **Delete** buttons render only for `canCreateLeagues(user)`
  (both deletes are `isSystemAdmin` on the server). Deletes confirm through `ActionMenu`, never an `Alert`,
  and a refused delete shows the server's reason via `getApiErrorMessage` in a toast; a successful delete
  leaves with `useGoBack` (pop, or replace with the parent from a deep link), never `router.replace`, which
  stacked a second copy of the parent screen under the one it returned to. **League delete rule
  = the API's (`leagueHasTeams`):** blocked locally only while some season has teams (message names teams);
  empty seasons cascade server-side. Before #614 the screen refused whenever any season existed, and a
  season row only showed a "coming soon" alert. Validation on edit mirrors `updateSeasonSchema` (name 1–100)
  plus the service's start ≤ end check. The season forms share `components/SeasonDateFields` (date rows +
  picker sheet, clear button as a sibling of the date button). Strings live under `seasons.*` and
  `leagues.delete*` in `i18n/locales`; the older admin screens (league list/create, season create) are still
  inline English. Tests: `__tests__/app/{season-detail,season-edit,league-detail-delete}.test.tsx`; both
  season screens are in the way-back list in `__tests__/app/error-state-way-back.test.tsx`. Maestro:
  `.maestro/admin-season-manage.yaml` (dev-login as the seeded ADMIN; creates and deletes "E2E Season";
  the seed removes a leftover).
- **About screen** (`app/about.tsx`, Profile → Settings → About): version + OTA diagnostics from
  `expo-constants` / `expo-updates` — app version, runtime version, applied update id + publish time
  ("Embedded build" when `!Updates.isEnabled || isEmbeddedLaunch || !updateId`, i.e. dev client or no OTA
  yet), channel, and a Share-sheet export (`formatAboutDiagnostics`) for OTA verification. This replaced the
  hardcoded version string in the Profile footer (it had drifted), and is the designated home for Terms of
  Service / Privacy Policy / open-source-license rows once #25 publishes the documents — don't add those
  links anywhere else. The **Help** card under the diagnostics holds **Contact support** (#450,
  `testID about-contact-support`, label `"Contact support, support@hooplings.com"`): it opens
  `buildSupportMailto(info)`, a `mailto:` to `config/env.ts#SUPPORT_EMAIL` with the diagnostics in the
  body, and shows a toast with the address when no mail app answers (every simulator). It is the only
  support link in the app; legal rows go below it. The App-version row appends the native build number ("v1.2.0 (build 28)") read via
  `requireOptionalNativeModule('ExpoApplication')` — never the `expo-application` JS wrapper, which would
  crash binaries without the module: `expo-application` first shipped in build #28 (cut 2026-08-28); since
  the 1.3.0 runtime boundary (#504) every OTA-reachable binary has it, but the guard stays for the bare-version
  degradation and the same guard shape as `services/secure-storage.ts`. `expo-application` is Expo-SDK-pinned and dependabot-ignored like the other
  native modules. Tests `__tests__/app/about.test.tsx` (note the
  lazy-getter `expo-updates` mock — Babel's `import * as` interop copies plain mock objects); Maestro
  `.maestro/profile.yaml`.

- **Account deletion** (#444, App Store 5.1.1(v)): Profile → Account → **Delete account**
  (`testID delete-account-row`) → `app/account/delete.tsx` — plain-language removed/kept summary,
  `Input` "Type DELETE to confirm" (exact, case-sensitive, trimmed — `isConfirmed`), destructive
  `Button` disabled until it matches and while pending (double-tap guard). Success:
  `hooks/useAccount.ts#useDeleteAccount` (`DELETE /auth/me`) clears the LOCAL session only
  (`clearSession`, no remote logout — the server side is already gone; never treat
  `clearSession` as a deletion) and the screen replaces to `/login`. A 400 `last_head_coach`
  (`getLastHeadCoachTeams(error)`) renders the blocking teams inline with links; anything else
  toasts via `getApiErrorMessage` and stays. The same screen with `?childId=` is the guardian
  path: Profile → **My kids** → ⋯ (`components/ActionMenu`, never an `Alert` menu) → "Delete
  <child>'s record" (only when `guardianOf[].isManaged`) → `useDeleteChildRecord`
  (`DELETE /players/:id/account`), which re-reads `GET /auth/me` so My kids drops the child at
  once, then pops back. **Deleted accounts elsewhere:** the API keeps the row as a tombstone with
  `deletedAt` set and an English placeholder name; render names ONLY via
  `utils/display-name.ts#displayName(user)` (localized `account.deletedUser` when `deletedAt`
  is set, stored name otherwise — never branch on the name) and derive roster chips ONLY via
  `getRosterStatus`, whose `'deleted'` branch comes first (a tombstone has `isManaged: false`,
  which would read as Active). A deleted roster row's menu offers only Remove player. The mobile
  types for invitation `player`/`invitedBy`, announcement `author` and `GameEvent.player` declare
  `deletedAt?`; until the API sends it on a payload, `displayName` falls back to the stored name. The
  `/invite/<token>` accept screen renders the inviter as `displayName({ name: inviterName, deletedAt:
  inviterDeletedAt })` (team by-token payload only; the guardian payload has no `inviterDeletedAt`).
  `__tests__/utils/display-name-guard.test.ts` reads `app/` and `components/` and fails on a raw
  `.name` read off any `…player`/`…Player`, `<x>.user` (staff rows), `invitedBy` or `author`; a bare
  `user.name` passes only in a file that binds `user` from the auth store (#674). Tests:
  `__tests__/app/account-delete.test.tsx`, `__tests__/hooks/useAccount.runtime.test.tsx`,
  `__tests__/utils/{display-name,display-name-guard,roster-status}.test.ts`, `__tests__/app/profile-my-kids.test.tsx`;
  Spanish-locale tombstone renders in `__tests__/app/{players-email-issue,invitations-guardian,announcement-thread}.test.tsx`
  (roster ⋯ sheet title, "Invited by", announcement author), `__tests__/app/invite-accept.test.tsx` (deep-link inviter)
  and `__tests__/components/game/EventTimeline.test.tsx`.
  Maestro: `.maestro/account-delete.yaml` (Mike Brown) and `.maestro/guardian-child-delete.yaml`
  (Gloria James / Bryce James) — both delete their fixture; re-seed before every run.

### Mobile permission gating (role matrix M3, M8, M9, M12–M18, M27, M4.1, M4.2)
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
  Start/End only with `canChangeStatus`, Delete with `canManage` on SCHEDULED and FINISHED games (hidden while
  IN_PROGRESS — end the game first; a finished-game confirm warns that the cascade removes the game's stats from
  season totals, and `useDeleteGame` invalidates `statsKeys.all`), Continue Tracking with `canTrack` (players keep
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
  **Add staff** (email + role chips), per-row role change (a `components/ActionMenu` listing the other staff roles,
  never an `Alert` list, disabled while a role update is pending; #688) and remove (a two-button `Alert` confirm) render only when
  `hooks/useTeams.ts#canManageStaff(team, userId, userRole, leagueAdminOf)` — ADMIN, admin of the team's league
  or a `HEAD_COACH`-type staff row (mirrors backend `canManageStaff`; flags can't tell head from assistant).
  Any staff member gets **Leave team** on their own row; the last head coach never gets a remove control. A
  `POST /staff` 404 (no account for that email) shows the inline "ask them to sign up first" hint — the
  endpoint never creates users. Hooks in `hooks/useTeamStaff.ts` (`useTeamStaff`, `useTeamRoles`,
  `useAddStaff`, `useUpdateStaffRole`, `useRemoveStaff`) invalidate the staff list, team detail/lists and
  `usageKeys.all` (staff rows are what the usage meter counts). Maestro: `.maestro/team-staff.yaml` (Frank Vogel =
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
  `name = email local part` and get the one-time display-name prompt — see "Display names" in `guardians.md` and `auth-sessions.md` (the prompt is
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

### Mobile date and time pickers (#576)
- **Every date or time choice goes through `components/DateTimePickerSheet`**; never render
  `@react-native-community/datetimepicker` in a screen. On iOS it is a bottom sheet with the
  wheels, Cancel and Done: the wheels edit a draft, Done commits it (`onConfirm`), Cancel and the
  backdrop discard it (`onCancel`), and every opening starts from the value the screen holds. On
  Android the library shows the system dialog, which has its own buttons. The picker it replaced
  was rendered inline at the end of the form and closed on the first change, so it opened under
  the keyboard and vanished as soon as one wheel settled.
- The screen calls `Keyboard.dismiss()` before it opens the sheet: `games/create` and
  `admin/seasons/create` both open with a focused text field.
- Version 9 of the library splits the old `onChange` into `onValueChange` and `onDismiss`; use
  those (`onChange` is deprecated and warns).
- The date and time rows on `games/create` carry `testID` `game-date-button` /
  `game-time-button` and the labels `Game date: <date>` / `Game time: <time>`; the sheet's
  buttons are `date-time-picker-done` / `date-time-picker-cancel`. Tap Cancel **by id**: the form
  behind the sheet has a Cancel button too. Tests: `__tests__/components/DateTimePickerSheet.test.tsx`,
  `__tests__/app/game-create-date.test.tsx`; Maestro `.maestro/game-create-date.yaml` (creates
  nothing, so it needs no seed reset).

### Mobile API errors, permissions & toasts
- **The API host is decided in ONE place: `config/env.ts#getApiUrl()`** (`extra.apiUrl` from
  `app.config.js`, else `http://127.0.0.1:3000` under `__DEV__`, else `https://api.hooplings.com`).
  `services/api-client.ts` and `services/socket.ts` import it; never read
  `Constants.expoConfig.extra.apiUrl` elsewhere. `__tests__/config/env.test.ts` pins the resolution
  order and `__tests__/app-config.test.ts` pins the `APP_ENV` → `apiUrl` mapping plus the
  `applinks:` entitlement (an OTA published with `APP_ENV` unset ships the dev host — see the OTA env
  gotcha in `../deployment/mobile-builds-and-ota.md`). Domain migration #502.
- `services/api-client.ts` registers an error-normalizing response interceptor **before** the 401/refresh
  interceptor. For any response with a JSON body it copies the server's `error` (or `message`) onto
  `error.message`, the server `code` onto `error.code`, and the whole body + `status` onto `error.apiError`.
  The existing `error instanceof Error ? error.message : fallback` sites therefore show the real reason
  (e.g. a 403's "You do not have permission to create teams in this league") instead of "Request failed
  with status code N". Helpers:
  `getApiErrorMessage(err, fallback)` and `isUpgradeRequiredError(err)` (402 or `code === 'upgrade_required'`).
  Network errors keep axios' own `code` (`ECONNABORTED`, …). A request that needs a session and
  was refused on the device for lack of one fails with `NoSessionError` (`code: 'ERR_NO_SESSION'`,
  `isNoSessionError(err)`); it never reached the server, so there is no `apiError` on it (#582,
  see "Ending a session must stay quiet" in `auth-sessions.md`).
- `hasTeamPermission(team, userId, permission, userRole?, leagueAdminOf?)` returns `true` for a system `ADMIN`
  regardless of staff rows and for an admin of the team's league (mirrors `backend/src/utils/permissions.ts`).
  Pass `user?.role` and `user?.leagueAdminOf` from the auth store (see "Mobile permission gating").
- Local user edits (avatar, role) go through `auth-store.updateUser(patch)`; `setUser` is for login only
  (it fires `USER_LOGGED_IN` analytics and `identifyUser`).
- Jersey numbers: `0` is a valid number — always test `jerseyNumber != null`, never truthiness.
- **A full-screen error on a pushed route needs a way back (#589, #595).** Every pushed screen
  draws its own header (the root `Stack` has `headerShown: false`) and returns
  `components/ErrorState` in its place, so the back arrow goes with it; with only `onRetry` the
  user is left with Try Again and the swipe gesture. Pass `onBack={goBack}` with
  `const goBack = useGoBack(<parent route>)` (`hooks/useGoBack.ts`): it pops the stack, or
  replaces with the parent when there is nothing to pop (a screen opened by a link), the same
  rule as `useAccessGuard`. Never `router.back()` alone, which does nothing without history. Every
  pushed screen that replaces itself with `ErrorState` does this (the guard below is the
  authority, not a count here). When there is nothing to
  retry, pass `onBack` without `onRetry` (the tracker's "This game is not in progress" had a
  Try Again button that left the screen). Tab screens have the tab bar and need nothing.
  `__tests__/a11y/error-state-way-back.test.ts` reads the source of `app/` outside `(tabs)/`
  and fails on an `<ErrorState` without `onBack`, unless the file is on its `KEEPS_HEADER` list
  (today only `teams/[id]/announcements`, where the error replaces the list under a header that
  stays); an entry there must have its own control labelled "Go back". Screen tests:
  `__tests__/app/error-state-way-back.test.tsx` (`SCREENS` enumerates every such screen; real
  hooks, the API failing);
  Maestro `.maestro/error-way-back.yaml` (read-only, opens a team and a game that do not exist).
- **Never put a pressable inside a pressable (#583).** On iOS an accessible element hides
  everything inside it from the accessibility tree, so a button nested in a pressable row can be
  tapped by a sighted user while VoiceOver and Maestro see only the row. On Profile → My kids
  that hid the ⋯ menu, the only way for a guardian to delete a child's record. Make the two
  **siblings inside a plain `View`**, each with a 44pt target (`childRow` / `childRowMain` /
  `childRowMore` in `app/(tabs)/profile.tsx`; the date rows in `admin/seasons/create`).
  `__tests__/a11y/nested-pressables.test.ts` reads the source of `app/` and `components/` and
  fails on any nesting, unless the outer pressable opts out with `accessible={false}`
  (`ActionMenu`'s sheet wrapper). A `ListItem` counts as a pressable only when it is given
  `onPress`. Screen tests cannot stand in for the guard: `getByLabelText` finds a nested button,
  which is how the defect shipped with a passing test. To assert it in a screen test, walk the
  `parent` chain of the button and expect no other accessible ancestor
  (`__tests__/app/profile-my-kids.test.tsx`).
- `components/Toast.tsx` renders toasts as a flowing column under the safe-area inset (newest at the bottom,
  at most `MAX_VISIBLE_TOASTS = 3`, oldest dropped) so concurrent toasts stack instead of overlapping.
  Toasts are **non-interactive** (`pointerEvents="none"`, auto-dismiss only — no swipe/tap to dismiss): the
  column overlays the top-left hero back arrow and top-right hero actions, and an interactive card swallowed
  taps meant for them for its whole 3s lifetime (#464 — surfaced as "back is a no-op after creating a team").
  Don't add touch handlers to a toast; anything tappable belongs elsewhere.
- **Screen-reader announcements (#774).** `utils/announce.ts#announce(message)` is the only caller of
  `AccessibilityInfo.announceForAccessibility*` (queued on iOS so a score change and the undo window are both
  heard; try/catch, failures logged without the message). Four call sites: every toast announces its message
  once on mount (`Toast.tsx`; React Native announces `accessibilityRole="alert"` on neither platform, and a
  `pointerEvents="none"` toast can never take focus); `UndoBanner` announces "<message>. Undo available for N
  seconds" once when the event is confirmed, never per countdown tick, and its button keeps the stable label
  "Undo"; the tracker's `ScoreDisplay` and Watch Live (`app/games/[id]/live.tsx`) render the score as one
  accessible element labelled `Score: <home> <n>, <away> <m>` with `accessibilityLiveRegion="polite"`
  (TalkBack) and announce changes on iOS through `hooks/useScoreAnnouncement.ts`, which never announces the
  first score it sees (mount, the game loading) and stays silent on Android so TalkBack does not hear each
  change twice. Tests: `__tests__/utils/announce.test.ts`, `__tests__/components/game/ScoreAnnouncement.test.tsx`,
  `__tests__/app/game-live-score.test.tsx`, and the #774 cases in `Toast.test.tsx` and `UndoBanner.test.tsx`.
- **The avatar photo menu is an `ActionMenu` (#669).** `AvatarPicker` (Profile, Manage Players) offers Take
  Photo, Choose from Library and, with a photo set, Remove Photo, plus the sheet's Close; the four-button
  `Alert` it replaced lost Cancel on Android and could not be dismissed with Back. On iOS the camera or
  library opens from the menu's `onDismiss` (iOS refuses to present while the modal is still closing), with
  a 1s fallback timer in case the callback never arrives; Android opens it at once. The permission-denied
  message stays a one-button `Alert`. Test: `__tests__/components/avatar-picker.test.tsx`.

### Mobile logging and error reporting (#617)
- **`services/log.ts` is the app's logger.** `log.debug` / `log.info` print to the Metro console in
  development and do nothing in a release build; `log.warn` / `log.error` also leave a Sentry
  breadcrumb (category `log`) once Sentry has initialized. Bare `console.*` anywhere else in app
  code is an ESLint error (`no-console`; allowed only in `services/log.ts`, `__tests__/` and
  `scripts/`). The module imports nothing, so `services/sentry.ts` and `services/analytics.ts` log
  through it during their own init; Sentry installs the breadcrumb sink (`setLogBreadcrumbSink`)
  after `Sentry.init` succeeds. Pass an `Error` under `data.error`; the sink keeps its name and
  message only.
- **Every API request leaves an `http` breadcrumb** (`services/api-client.ts#observeResponse` /
  `observeError`, registered after the error-normalizing interceptor and before the 401 handler):
  method, the redacted route pattern, `status_code`, `duration`. **Captured** with tags
  `endpoint_pattern` and `status`: a network failure (no response, `status: 'network'`, axios `code`
  in context) and any 5xx. A 4xx is the user's own outcome and is a breadcrumb only; an axios
  cancellation (`ERR_CANCELED`) is a breadcrumb only (level `warning`, `reason: 'ERR_CANCELED'`) and is
  never captured. A `NoSessionError` (#582) is captured **once per endpoint
  pattern per session end** (keyed on `getLogoutEpoch()`), so a screen that retries after sign-out
  reports one event, not a storm; every refusal still leaves a breadcrumb.
- **`endpointPattern(url)`** (`services/sentry.ts`) is the only shape a URL takes in a tag or
  breadcrumb: `redactUrl` first, then scheme, host and query dropped, then every UUID, cuid or
  numeric segment collapsed to `:id` (`/api/v1/teams/:id/games/:id`), so one tag value groups a
  route. `addBreadcrumb` redacts eagerly as well as in `beforeSend`: the message and every string in
  the data bag go through `redactUrl` and the key scrub, so a crumb never holds a token, an OAuth
  code or an email even before it is sent. `__tests__/services/sentry.test.ts`,
  `api-client-observability.test.ts` and `socket.test.ts` assert the absence of each.
- **Socket breadcrumbs** (`services/socket.ts`, category `socket`): `connected` / `reconnected`
  (with socket.io's `recovered` flag), `disconnected` (reason), `connect_error` (message) and every
  recovery decision (refreshing the token, backing off, abandoning). Messages are socket.io's fixed
  strings; no URL or token is involved.
- Jest mocks `@sentry/react-native` globally (`jest.setup.js`); a suite that asserts on the SDK
  installs its own mock, as `sentry.test.ts` does.

## Analytics events, user properties and screen views (#616)

The event catalogue, the user properties set on identify, the screen-view tracker and the
enforcement test are in `analytics.md`. In short: `trackEvent` accepts only `AnalyticsEvents`
names with per-event typed properties; mutation hooks emit from `onSuccess`; no property carries
PII; a new event is a row in that doc in the same PR.

## Analytics tracking options (#559)

`mobile/services/analytics.ts` passes `AMPLITUDE_TRACKING_OPTIONS` to `amplitude.init`; the SDK's
defaults are never relied on (they turn everything on). Two values are decisions:

- **`ipAddress: true`** — kept on purpose (product decision 2026-09-27) so Amplitude derives city,
  region and country. It is declared as **Coarse Location** in the privacy-label draft
  (`docs/release/app-store-submission.md`) and in the runbook's "Retention" section. The device's
  location services are never used. `country: false` goes with it: that option is the country the
  device reports, and enabling it disables the server-side lookup that supplies the city.
- **`adid: false`** — the Android advertising id is never sent; the app shows no ads and the label
  answers "no tracking".

`__tests__/services/analytics.test.ts` pins the full set and compares its keys against the
installed SDK's defaults, so an SDK upgrade that adds a tracking option fails CI until it is
decided. Changing an option means changing the label draft and the runbook in the same PR. It is
JS only, so it ships by OTA.

Also JS only, and from the api-client rather than a hook: `entitlement_denied` on every 402 and
`error_shown` whenever `getApiErrorMessage` is asked for a message to display (`analytics.md`).
