# Plan: account deletion — `DELETE /auth/me` + guardian child deletion (#444)

GA blocker (App Store Review Guideline 5.1.1(v); CCPA/GDPR deletion rights the privacy policy
in #25 will promise; a parent's COPPA route to remove a child's record). Written 2026-09-07 against
`main` at 20d0f50, before any code. Reviewed with `/plan-eng-review` the same day: 9 review findings
plus 10 from the outside voice, all folded into the decisions below (report at the end).

## Problem (verified against the code)

There is no deletion path anywhere. `backend/src/api/auth/routes.ts` mounts `GET`/`PATCH /me`,
`PATCH /me/role`, `POST /logout`, `POST`/`DELETE /push-token` — no `DELETE /me`.
`PlayerService.deletePlayer` (`player-service.ts:424`) is a roster tool: it only accepts `PLAYER`
rows, refuses anyone on a team or with game events, and then **hard-deletes** through ~29
`onDelete: Cascade` relations. Nothing lets an account owner remove themselves, and a guardian who
unlinks via `DELETE …/guardians/:id` leaves the child's `User` row, name, photo and stats behind.

Apple's own wording (developer.apple.com, 5.1.1(v) news posts): deletion must be *initiable in the
app*; "temporarily disable or deactivate" is insufficient; data kept for legal reasons should be
anonymized or minimized; a confirmation step is fine and a grace period is allowed but not required.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Anonymize in place, never hard-delete.** The `User` row survives as a tombstone; personal data is removed from it. | Game history and season stats stay coherent for the other members (`GameEvent.playerId` / `PlayerStats` / `TeamStats` all key on the user id). A hard delete cascades through 29 relations and silently rewrites every team's box scores. Matches the issue's suggested semantics. True erasure for accounts with **no** history is a filed follow-up (review 10A), not part of this change. |
| D2 | **Add `User.deletedAt DateTime?`** (additive, nullable migration). | Makes the tombstone explicit instead of inferred from `email IS NULL AND name = 'Deleted user'`: lists can filter it, the seed can purge it, the runbook can prove when a request was honoured, and the auth middleware can refuse it without heuristics. Prisma-generated `ADD COLUMN … NULL` is safe on a populated table (no backfill — the hand-written-migration rule from #462 does not apply). |
| D3 | **Delete the WorkOS user** (`workos.userManagement.deleteUser`, SDK 8.13 has it), best-effort **after** the DB transaction commits; fall back to `revokeSession` if delete throws. *(Review 1A.)* | Apple's guideline means the account, not just our row; WorkOS holds the email and name too. Deleting the IdP user also kills every session and refresh token, so `POST /auth/logout`'s `sid` dance is unnecessary. Ordering: local unlink first, so a WorkOS outage leaves the person *unable to reach the tombstone* (they would get a brand-new account on next sign-in, which is acceptable and documented). After the #24 key cutover a row still carrying a *staging* WorkOS id will 404 here — same `identityDeleted: false` path, runbook step. |
| D4 | **Last head coach blocks with 400** `code: 'last_head_coach'` + the affected `teams: [{ id, name }]`, **scoped to teams whose season `isActive`**; historical team-seasons go headless. *(Review 15A.)* | Auto-promoting a random assistant hands a team (roster with minors' emails) to someone who did not ask for it. Deleting the teams for them destroys other people's data. Since #462 a `Team` row is a team-season, so an unscoped block would force a long-tenured self-serve coach to delete past seasons (destroying the stats D1 exists to keep) or find another adult with an account for each. Blocking only on live seasons keeps the protection where a team can still be managed and is reversible in-app: **Delete team** (`mobile/app/teams/[id].tsx:137`) and re-roling on the staff screen. Headless past seasons stay readable; league admins / ADMIN can still edit them. Reuses the rule in `TeamService.assertNotLastHeadCoach` (`team-service.ts:938`) via the shared helper in D11. |
| D5 | **Guardian child deletion = `DELETE /players/:id/account`**, allowed when the caller is a guardian of `:id` AND the child is `isManaged` with `workosUserId IS NULL`. **A claimed account (`workosUserId` set) is deletable only by its owner via `DELETE /auth/me` — not by guardians, not by system ADMINs through the API.** The route check is a fast path; **the service re-checks `isManaged` / `workosUserId` / `deletedAt` after the row lock** and answers 403 from inside the transaction. *(Review 14A.)* | Acceptance criterion 2 verbatim. A child claiming the account via `syncUser` between the route check and the lock must not let a guardian delete a claimed account. Offline data-subject requests for claimed accounts go through the operator script (D7), never a privileged API route that could be reached with a stolen admin token. |
| D6 | The same `AccountService.deleteAccount(targetUserId, actor)` implements both routes and the script; the route decides *who may*, the service decides *what happens*, in ONE `$transaction`. | "A half-deleted account is worse than none" (issue). One code path = one test matrix. |
| D7 | Operator script `backend/scripts/data-subject-request.ts` with `export <email>` and `delete <email>`, run with `tsx` (already a dependency) against a `DATABASE_URL`. **The script is a thin CLI: export logic lives in `AccountService.exportUserData(userId)`** so the real-Postgres suite proves it. *(Review 8A.)* Script `delete` runs the service in `mode: 'operator'`: it skips the owner/guardian gate (identity was verified by hand per the runbook) but still enforces the last-head-coach rule. | The runbook has to cover **export** too (acceptance criterion 6) and there is no export endpoint; a script the runbook can name beats a paragraph of ad-hoc SQL. Export is JSON to stdout, never written to the repo or S3. |
| D8 | Retention statement (for #25): tombstone keeps `id`, `role`, `createdAt`, `deletedAt`; `GameEvent`, `PlayerStats`, `TeamMember` and authored `Announcement` rows stay, attributed to "Deleted user"; RDS automated backups keep the pre-deletion data for up to **7 days** (`infra/rds.tf:72`); **error reports (Sentry, `utils/sentry.ts:237` sets the raw user id) and usage analytics (Amplitude, `mobile/services/analytics.ts:69`, id only, no properties) keep records keyed on the internal id for those vendors' retention windows** — pseudonymous once the row is scrubbed, since no name, email or photo exists anywhere for that id. Log lines hash email addresses (`hashRecipient`). No vendor deletion API call. *(Review 20A.)* | The privacy policy must describe this truthfully; the earlier "hashed identifiers only" wording was false against the code. The PR body will restate it and a comment goes on #25. |
| D9 | **Every write onto the row is guarded by `deletedAt IS NULL`.** `PATCH /auth/me` (`routes.ts:440`), `PATCH /auth/me/role`, `NotificationService.registerToken` (push-token upsert) **and both `syncUser` branches** (`workos-service.ts:181` linked update, `:209` claim update) become conditional writes: the self-writes answer 401 on zero rows; `syncUser` falls through to the create branch on zero rows (the claim branch also requires `workosUserId: null`), the same claim-guarded `updateMany` shape as the RT4 write in `team-service`. *(Review 2A, 13A.)* | A request that passed `authenticate` — or a sign-in that read the row — a moment before the deletion commits still runs its `update({ where: { id } })` afterwards and writes a real name, role, device token, email or WorkOS id back onto the scrubbed row. Milliseconds wide, silent, and fixed by a where-clause. |
| D10 | **Keep `TeamMember` rows; delete `GameRsvp` rows.** *(Review 3A, 4A.)* | Box scores come from events, but the season per-player table walks the roster (`stats-service.ts:848` loads `teamMember` rows and aggregates each player's `PlayerStats`); removing the row drops the player from the leaderboard while `TeamStats` totals keep their points. The coach's existing Remove-from-roster action is the stats-safe cleanup. RSVP rows carry nothing but the id and only serve the person: one rule for the transaction. |
| D11 | **Extract two shared helpers instead of copying rules.** `utils/permissions.ts#lastHeadCoachTeams(userId, db, { teamIds?, activeSeasonsOnly? })` — ONE set-based query (all HEAD_COACH-type staff rows across the caller's head-coach teams joined to `season.isActive`, grouped in memory; teams whose distinct holders are exactly the caller) — used by `assertNotLastHeadCoach` (single team id, any season: staff removal is always about the current team) and the deletion transaction (`activeSeasonsOnly: true`). `GuardianService.promoteNextPrimary(tx, childId)` — extracted from `removeGuardian` (`guardian-service.ts:441-449`) and reused by the deletion loop. *(Review 5A, 9A, 15A.)* | DRY: the B2.8 team-cap drift is the precedent for what copied rules cost. Existing suites (`tests/services/team-service.test.ts`, `tests/api/teams.test.ts`, `tests/services/guardian-service.test.ts:445,471`) are the regression proof. |
| D12 | **The central error handler spreads `details` for any `AppError` carrying them.** A `DetailedError` base (`code` + `details`) that `PaymentRequiredError` and the new `LastHeadCoachError` extend; `index.ts` writes `{ success: false, error, ...details }`; the per-route copy at `teams/routes.ts:75` goes away. *(Review 6B.)* | Today the 402 body is hand-rolled in one route because the handler emits only the message. A second structured error would copy that; a passthrough is four lines and the five existing 402 suites are the regression gate. Mobile's `getApiErrorMessage` / `error.apiError` contract is unchanged. |
| D13 | **The seeded child fixture gets a fixed real UUID** (`BRYCE_JAMES_ID` constant in `seed.ts`), upserted by id together with its `TeamMember` and `Guardian` rows — the same shape the other managed fixtures already use (`seed.ts:597` onward; the `managed-` prefix sweep at `:595` is legacy cleanup, not the reset path). *(Review 7A; corrected per outside voice #8.)* | Every `/players/:id` route runs `validateUuidParams('id')` (`players/routes.ts:105-169`); a non-UUID id would 400 on the very call the Maestro flow exists to test, and read as an app bug. |
| D14 | **Tombstones are hidden from pickers** in the same PR: `deletedAt: null` in `PlayerService.listPlayers` / `getPlayerById` scoping, in `TeamService.addStaffMember`'s user lookup, in guardian listings and in `GET /auth/dev-users`. **`deletedAt` is added to `USER_SUMMARY_SELECT`** (`team-service.ts:48`) so every roster / staff / guardian payload carries it, and mobile derives a new `'deleted'` roster status (`utils/roster-status.ts`, neutral "Deleted" chip, no Resend / Invite / Cancel actions) and a **localized** "Deleted user" label (`account.deletedUser` in `en`/`es`) whenever `deletedAt` is set, using the stored name only as a fallback for old clients. *(Review 11C, 18A.)* | One-line clauses beside code the PR already reads; "Deleted user" must never be selectable as staff or in roster search. Without the chip branch, `isManaged === false` renders a deleted managed child as **Active** (`roster-status.ts:9`). Rosters and season tables still show the row by design (D10). |
| D15 | **ADMIN self-delete is allowed, no special case.** *(Review 12A.)* | The `ADMIN_EMAIL` allowlist re-promotes the same email on its next sign-up (`isAdminEmail` on create), so recovery is a sign-up away; the typed confirmation is the guard. Documented in the runbook. |
| D16 | **The personal league is renamed to a neutral value and deleted when no team references it**, inside the transaction. *(Review 16A.)* | `createTeam` names it `${userName}'s Teams` (`team-service.ts:262`), so the name would survive in a table the original plan never listed, visible to every member of a team in it. Nulling `personalOwnerId` also flips `isPersonal` to false, so an empty container would appear in ADMIN league listings with zero admins forever. The last-head-coach rule guarantees any remaining team has another head coach; the League delete cascades to seasons only when zero teams reference it, which the db test proves. |
| D17 | **`GuardianInvitation.invitedEmail` is scrubbed on every row matching the address** (case-insensitive) — PENDING rows are expired first, then all matching rows get a per-row sentinel `deleted-<invitationId>@invalid`. *(Review 17A.)* | The column is `NOT NULL` on every row (`schema.prisma:395`); flipping only PENDING rows leaves the deleted adult's email on ACCEPTED / EXPIRED rows forever, and a stale accept-by-token could mint a PARENT account from it. The partial unique index covers PENDING only, so the sentinel cannot collide; `listPendingForUser` already filters on status + expiry. |
| D18 | **A sole league admin may delete themselves; the league goes admin-less and the runbook's post-deletion checklist repairs it.** *(Review 19B — outside voice #7 rejected.)* | `POST /leagues/:id/admins` is system-ADMIN-only (decision 3), so unlike a head coach a league admin cannot appoint their own replacement; a `last_league_admin` block would strand them with no in-app exit, which 5.1.1(v) forbids outside regulated industries. The deletion log line lists leagues left without an admin. |

## What deletion does

```
DELETE /auth/me ─┐                                  ┌─ after commit (best-effort, logged, Sentry on failure)
DELETE /players/:id/account ─┼─► AccountService.deleteAccount(target, actor) ─┤
scripts/data-subject-request delete ─┘                                        │
                                                                              ▼
  $transaction                                                     deletePreviousAvatar(oldUrl, null)
  ┌──────────────────────────────────────────────────────────┐    WorkOSService.deleteUser(oldWorkosId)
  │ 1  SELECT … FROM "User" WHERE id=$1 FOR UPDATE            │      └─ throws → revokeSession fallback → identityDeleted:false
  │    deletedAt not null ─────────────────────────► 404      │
  │    mode guardian: !isManaged || workosUserId ──► 403      │  (D5, re-checked under the lock)
  │ 2  mode self|operator:                                    │
  │    lastHeadCoachTeams(user, {activeSeasonsOnly}) non-empty│
  │      ───────────────────► LastHeadCoachError 400 {teams}  │  (rollback: nothing written)
  │ 3  purge rows that only serve the person                  │
  │    pushToken, calendarFeedToken, teamStaff, leagueAdmin,  │
  │    gameRsvp  ── deleteMany            (log admin-less leagues, D18)
  │    guardian (as parent) ── delete + promoteNextPrimary    │
  │    guardian (as child)  ── deleteMany                     │
  │    teamInvitation PENDING (playerId) ── → CANCELLED       │
  │    guardianInvitation PENDING (invitedEmail | childId) ── → EXPIRED
  │    guardianInvitation ALL rows (invitedEmail) ── invitedEmail → sentinel (D17)
  │    league (personalOwnerId=me) ── name → neutral, owner → null;
  │                                   delete when no team references it (D16)
  │    user.managedById = me ── → null                        │
  │ 4  tombstone: workosUserId, email, profilePictureUrl → null│
  │    name → DELETED_USER_NAME, emailVerified/isManaged false│
  │    managedById null, tier FREE, expiresAt null,           │
  │    deletedAt = now()                                      │
  └──────────────────────────────────────────────────────────┘
  KEPT (de-identified): TeamMember, GameEvent, PlayerStats, Announcement (author), TeamInvitation *sent*
  NOT touched: RefreshToken (dead table — no writer in src/, WorkOS holds refresh tokens)
```

`AccountService.deleteAccount(userId, { actorId, mode: 'self' | 'guardian' | 'operator' })`:

1. `SELECT … FOR UPDATE` on the user row (same lock shape as `createTeam`) — a concurrent second
   delete, a concurrent self-write or a racing sign-in serializes behind it. 404 if already
   `deletedAt IS NOT NULL`; in `guardian` mode, 403 unless still `isManaged && workosUserId IS NULL`.
2. **Last-head-coach check** (`self` and `operator`; managed children hold no staff rows) through
   `lastHeadCoachTeams(…, { activeSeasonsOnly: true })` (D11), inside the transaction so a staff
   change cannot slip between check and delete. Non-empty → `LastHeadCoachError` (400,
   `code: 'last_head_coach'`, `teams`).
3. Purge, as diagrammed. `promoteNextPrimary` runs per child the user was primary guardian of.
   The personal league is renamed (`'Former coach\'s teams'` — a constant beside
   `DELETED_USER_NAME`) and deleted when `team.count({ where: { season: { leagueId } } }) === 0`.
   Managed players they created stay managed; only ADMINs can edit them afterwards, same as today
   after the creator leaves the roster (B2.10). Leagues left with zero admins are logged at info
   with their ids (D18).
4. Tombstone. `DELETED_USER_NAME = 'Deleted user'` is an exported constant on the service (tests
   import it; mobile renders its own localized label from `deletedAt`, D14). `role` is left as
   is. Capture the previous `profilePictureUrl` and `workosUserId` for step 5.
5. After commit: `deletePreviousAvatar(previousUrl, null)` (own bucket only, never WorkOS URLs —
   `upload-service.ts:94`), then `WorkOSService.deleteUser(workosUserId)` (new thin wrapper; skipped
   when the id was null — managed child / dev user). A failure is `captureException`ed with
   `flow: 'account-delete'` and the response is still 200 `{ success: true, identityDeleted }`.

`AccountService.exportUserData(userId)` (D7): one JSON object — user row (minus `workosUserId`),
teams (member + staff rows with team/season/league names), guardians both directions, invitations
both directions (guardian invitations by `invitedEmail` and by `childId`), RSVPs, game events,
player stats, push-token platforms, calendar-feed teams, announcements authored. Tested against
real Postgres for table coverage.

### Why the identity cannot come back (acceptance criterion 3)

- `authenticate` (`api/auth/middleware.ts`) resolves `workosUserId = sub`; null never matches →
  401 on every request with the old token. The dev-token branch resolves by `id`, so it gains an
  explicit `deletedAt IS NULL` guard (and `GET /auth/dev-users` filters, D14).
- `syncUser` (`workos-service.ts`) step 1 matches `workosUserId` (null → miss); step 2 matches
  `email` (null → miss); step 4 **creates a fresh row**. The tombstone is never claimed in the
  steady state, and D9 closes the race: a sign-in that read the row before the deletion committed
  finds zero rows on its guarded update and falls through to create. Covered by a service test and
  a real-Postgres case that deletes, then runs `syncUser` for the old identity, and asserts a
  *different* `id` with the tombstone unchanged.
- WorkOS-side deletion (D3) additionally invalidates the refresh token, so the mobile
  single-flight refresh gets 401 → `logout()` even if the app somehow kept tokens.
- D9 closes the remaining write paths: a request already past `authenticate`.

Known, accepted: a `teamStaff.create` for the deleting user that is *waiting* on the row lock
(FK `KEY SHARE` on `User`, prior learning `pg_fk_insert_keyshare_defeats_sorted_for_update`)
proceeds after commit and attaches a staff row to the tombstone. Two humans acting on the same
account in the same second; D14 keeps the tombstone out of the staff picker, which makes the
window unreachable from the app. Not guarded further.

## Routes

| Route | Gate | Answers |
| --- | --- | --- |
| `DELETE /api/v1/auth/me` (no body, `authenticate`, general limiter) | any authenticated user, ADMIN included (D15) | 200 `{ success, identityDeleted }`; 400 `last_head_coach` + `teams`; 401 |
| `DELETE /api/v1/players/:id/account` (`authenticate`, `validateUuidParams('id')`) | route fast path: `isGuardianOf(caller, :id)` AND target `isManaged && workosUserId == null`; the service re-checks under the lock (D5); 403 (`Only the account owner can delete a claimed account` when claimed; generic 403 otherwise); 404 unknown / already deleted | 200 `{ success }` |

`GET /auth/me` / `/auth/callback` / `/auth/dev-login` add `guardianOf[].isManaged: boolean` (from
`GuardianService.getGuardianOf`, which already selects the child) so the app can show "Delete
record" only where the API would allow it. Additive on the shared `GuardianOfEntry` type.
`USER_SUMMARY_SELECT` adds `deletedAt` (D14), additive on the shared user-summary shape.

## Mobile (PR 2)

- **Profile → Account → "Delete account"** (red row under Name / Account Status, `testID
  delete-account-row`, a11y label "Delete account") → `app/account/delete.tsx`. Two taps from
  Profile to the confirm button (criterion 4: ≤ 3).
- The screen: plain-language summary — *Removed:* your name, email, photo, sign-in, notifications,
  calendar links, team roles, guardian links, pending invitations. *Kept (without your name):* game
  stats and box scores already recorded for your teams. Then an `Input` "Type DELETE to confirm"
  and a destructive `Button` disabled until the trimmed text equals `DELETE` (case-sensitive) and
  disabled again while the request is pending (double-tap guard). Success: toast "Your account has
  been deleted", `useAuthStore.getState().clearSession()` (local only — the server side is already
  gone, so no `runRemoteLogout`; the issue's warning is the other direction: never treat
  `clearSession` as deletion), then `router.replace('/login')`. A 400 `last_head_coach` renders the
  team names inline with "Make someone else Head Coach or delete these teams first" and a link to
  each team. Any other failure: error toast via `getApiErrorMessage`, the screen stays, the button
  re-enables.
- **Guardian child record:** each "My kids" row gains a trailing "More options for <child>"
  button opening a `components/ActionMenu` (never an `Alert` menu — Android caps at three
  buttons): *View stats*, *Manage guardians* (when the child has teams; replaces the current
  inline icon), *Delete <child>'s record* (only when `isManaged`). The last opens the same
  `app/account/delete.tsx?childId=<id>` with child-specific copy, calls
  `DELETE /players/:id/account`, then re-reads `GET /auth/me` (the pattern the invitations tab
  uses after a guardian accept) and pops back with a toast. Row tap → stats stays as today, so
  `profile-my-kids.test.tsx` keeps passing.
- **Deleted rows elsewhere (D14):** `utils/roster-status.ts#getRosterStatus` returns `'deleted'`
  when `member.player.deletedAt` is set (checked first, before the `isManaged` / invitation
  branches); the chip is neutral "Deleted" and the row's `ActionMenu` offers only *Remove from
  team*. A shared `utils/display-name.ts#displayName(user)` returns `t('account.deletedUser')`
  when `deletedAt` is set, else `user.name`; roster cards, staff rows, guardian rows, box scores
  and leaderboards go through it (never inline the `deletedAt` check in a screen — same rule as
  `game-result.ts`).
- Hooks in `hooks/useAccount.ts`: `useDeleteAccount()` and `useDeleteChildRecord()`.
  Error text through `getApiErrorMessage`; the `last_head_coach` body is read from
  `error.apiError`.
- i18n: new `account.delete.*` and `account.deletedUser` keys in `en.json` + `es.json` (screen
  tests render the real instance; never stub `t`).

## Seed / fixtures

- Purge tombstones at the top of `seed.ts` (`user.deleteMany where deletedAt not null` — a
  cascading hard delete, fine while no fixture that gets deleted carries game events) so repeated
  Maestro runs do not accumulate "Deleted user" rows in the dev-login list.
- **Self-delete fixture: Mike Brown** — seeded Warriors *Assistant* Coach (`seed.ts:475`), so he is
  never a last head coach and the flow reaches the success path; the seed's `upsert where email`
  recreates him for the next run.
- **Child fixture: Bryce James**, `BRYCE_JAMES_ID` = a fixed UUID (D13), Lakers, `isManaged`,
  `managedById` Frank, **Gloria James** as guardian (MOTHER); user, `TeamMember` and `Guardian`
  rows all upserted by id like the existing managed fixtures. Gloria is already a seeded pure
  guardian of LeBron.

## Tests

Backend (PR 1):

- `tests/services/account-service.test.ts` (mocked Prisma): step order; last-head-coach throws
  and writes nothing; guardian mode refuses claimed / non-guardian at the route AND under the lock;
  operator mode skips the gate but keeps the head-coach rule; primary-guardian promotion; personal
  league renamed vs deleted; invitedEmail sentinel; WorkOS failure still resolves with
  `identityDeleted: false`; avatar delete called with the old URL; admin-less leagues logged.
- `tests/api/auth.test.ts`: `DELETE /me` 200 / 400 body shape (`code`, `teams`) / 401 after
  deletion; **`PATCH /me`, `PATCH /me/role`, `POST /push-token` on a deleted row → 401 and no
  write** (D9); dev-token branch refuses a deleted row; `GET /dev-users` excludes tombstones.
- `tests/api/players.test.ts`: `DELETE /players/:id/account` matrix (guardian+managed 200; guardian
  of claimed 403; non-guardian 403; ADMIN 403 on claimed; bad UUID 400); `listPlayers` /
  `getPlayerById` exclude tombstones (D14).
- `tests/api/teams.test.ts`: `POST /staff { userId: <tombstone> }` → 404 (D14); `GET /teams/:id`
  members carry `deletedAt`; existing 402 body assertions unchanged after D12.
- `tests/api/errors.test.ts` (or the existing error-handler suite): the central handler spreads
  `details` for a `DetailedError`; plain `AppError` bodies unchanged.
- `tests/services/workos-service.test.ts`: `syncUser` after deletion creates a new row; both
  guarded updates fall through to create on zero rows.
- `tests/utils/permissions.test.ts`: `lastHeadCoachTeams` — sole head coach on 2 of 3 teams
  returns exactly those 2 in one query; co-head team excluded; `teamIds` filter;
  `activeSeasonsOnly` drops an inactive-season team.
- **`tests/integration/account-deletion.db.test.ts` against real Postgres** (same harness as
  `league-access.db.test.ts`): a user with three teams (head coach on one with a co-head, sole head
  coach on one in an **inactive** season, assistant on the third), game events, PlayerStats, an
  RSVP, a guardian link each way, a pending team invitation, an ACCEPTED and a PENDING guardian
  invitation addressed to them, and a personal league. Assert: tombstone columns; staff/RSVP/tokens
  gone; events + stats + membership intact and still attributed to the id; invitations flipped and
  every `invitedEmail` scrubbed; the co-head still there; the inactive-season team is headless and
  did not block; personal league renamed (non-empty case) / deleted (empty case, seasons gone too);
  a child with two guardians deleted by one drops out of the other's `getGuardianOf`; a second call
  → 404; **two concurrent calls → one 200, one 404**; the last-head-coach variant (sole head on an
  active season) leaves every row untouched (real rollback); a `PATCH /me` executed after the
  delete on the same row leaves the tombstone unchanged; `syncUser` with the old identity after
  the delete creates a new row; `exportUserData` output names every table the runbook lists.
- Schema test: `deletedAt` present, nullable; `USER_SUMMARY_SELECT` includes it.

Mobile (PR 2): `__tests__/app/account-delete.test.tsx` — button disabled until `DELETE` (and
**not** for `delete`), disabled while pending (double-tap sends one request), success clears
session + navigates, `last_head_coach` renders team names with links, 500 shows a toast and the
screen stays with the button re-enabled, child mode renders child copy and re-reads `/auth/me`
then pops, 403 in child mode toasts and stays; `__tests__/app/profile-my-kids.test.tsx` extended:
menu items, "Delete record" absent for a claimed child; `__tests__/hooks/useAccount.runtime.test.tsx`;
`__tests__/utils/roster-status.test.ts` — `deletedAt` wins over every other branch;
`__tests__/utils/display-name.test.ts` — localized label in `en` and `es`.
Maestro: `.maestro/account-delete.yaml` (Mike Brown → Profile → Delete account → type DELETE →
login screen → dev-login list no longer lists him) and `.maestro/guardian-child-delete.yaml`
(Gloria → My kids → Bryce → Delete record → My kids shows LeBron only; then Frank Vogel's Lakers
roster shows the "Bryce James status: Deleted" chip). Both need `npx prisma db seed` before each
run, like every other flow.

## Docs

- `docs/runbooks/data-subject-requests.md`: self-serve delete, guardian delete, operator delete
  and export via the script (identity verification first: reply from the account email, or a
  guardian invitation on file), what is retained and why (D8 verbatim, vendor windows named),
  the 7-day backup window, WorkOS dashboard fallback when `identityDeleted: false` (including the
  staging-id case after #24), ADMIN self-delete and the allowlist re-promotion (D15), the
  **post-deletion checklist** (admin-less leagues from the log line → `POST /leagues/:id/admins`,
  headless past-season teams), and a log table like the RDS runbook's drill log. Linked from
  `CLAUDE.md` "Operations / Runbooks".
- `CLAUDE.md`: an "Account deletion" subsection under session tokens; mobile notes under
  routing/guards and the roster chip section; the retention statement.
- `docs/testing/e2e-test-plan-v2.0.md`: two new sections.
- Comment on #25 with the retention statement (D8); status comment on #444 at each merge; file the
  true-erasure follow-up (review 10A) and link it from #444.

## PR split

1. **PR 1 — backend** (`feature/444-account-deletion-backend`): migration, service, routes,
   `syncUser`/middleware guards, D9 write guards, D11 helpers, D12 error handler, D14 filters +
   `USER_SUMMARY_SELECT`, D16/D17 purge steps, `guardianOf.isManaged`, seed fixtures, script,
   runbook, tests, CLAUDE.md. Deploys on merge (migration is additive; `prisma migrate deploy` at
   container start).
2. **PR 2 — mobile** (`feature/444-account-deletion-mobile`): screen, menu, hooks, roster status +
   display-name helpers, i18n, Jest, Maestro, e2e plan, CLAUDE.md; production OTA in the same
   session as the merge (runtime 1.3.0, no native change).

## What already exists (reused vs rebuilt)

| Existing | Used as |
| --- | --- |
| `createTeam`'s `SELECT … FOR UPDATE` on the caller row | the lock shape in step 1 |
| `TeamService.assertNotLastHeadCoach` (`team-service.ts:938`) | extracted into `lastHeadCoachTeams` (D11), old caller refactored |
| `GuardianService.removeGuardian` primary promotion (`:441-449`) | extracted into `promoteNextPrimary` (D11) |
| `deletePreviousAvatar` (`upload-service.ts:94`) | step 5, unchanged |
| `WorkOSService.revokeSession` | fallback in step 5 |
| `GuardianService.getGuardianOf` | gains `isManaged` |
| `PaymentRequiredError.details` + `teams/routes.ts:75` | generalized into `DetailedError` + handler passthrough (D12) |
| RT4 claim-guarded `updateMany WHERE workosUserId IS NULL` (team-service) | the shape of every D9 guard |
| `validateUuidParams`, `authenticate`, general limiter | unchanged, applied to the new routes |
| `utils/roster-status.ts#getRosterStatus`, `components/ActionMenu`, `SortPills` rule | gain the `'deleted'` branch; no new chip component |
| `PlayerService.deletePlayer` (hard delete) | **not** reused; different semantics, stays for roster hygiene |
| Mobile `Input`, `Button`, toast, `getApiErrorMessage`, `clearSession` | unchanged |

## NOT in scope

- **Hard-delete of statistics on request** — needs a per-team stats recompute; file separately if
  counsel asks.
- **Account deactivation / grace period** — Apple does not require it and it complicates the
  re-signup story; D3 makes deletion immediate.
- **True erasure for zero-history accounts** — filed as a follow-up issue (review 10A); D1 stays
  one behaviour in this change.
- **Guardian deleting a claimed child account** — the child owns it (D5).
- **A `last_league_admin` block** — rejected (D18); the person could not clear it themselves.
- **Vendor-side deletion (Amplitude user-deletion API, Sentry)** — no personal properties are
  stored there; a new backend secret and async vendor job for a pseudonymous id (D8).
- **Web (`web/`) UI for deletion** — no signed-in web surface exists.
- **A demote-ADMIN endpoint** — D15 relies on the allowlist re-promotion instead.
- **Distribution** — no new artifact type; backend deploys through the existing ECS pipeline,
  mobile through the existing OTA channel.

## Failure modes

| Codepath | Realistic failure | Test | Handling | User sees |
| --- | --- | --- | --- | --- |
| Transaction step 1–4 | Postgres error mid-way | db test (rollback on last-head-coach) | `$transaction` rollback | 500 toast, nothing changed, retry works |
| Step 1 guardian mode | child claims account between route check and lock | service test | re-check under lock → 403 | "Only the account owner…" toast |
| Step 2 | staff change between check and delete | db test (lock serializes) | inside the transaction | n/a |
| Step 3 league delete | a team still references the league | db test (non-empty case) | count check → rename only | n/a |
| Step 5 WorkOS | outage / 404 (staging id) | service test | logged + Sentry, `identityDeleted:false` | success toast; operator finishes per runbook |
| Step 5 S3 | delete fails | service test | `deletePreviousAvatar` swallows + warns | nothing; orphan object, harmless |
| Stale self-write | `PATCH /me` after commit | db test | D9 where-clause → 401 | request fails, app already logged out |
| Racing sign-in | `syncUser` read before commit, update after | db test | D9 guard → zero rows → create | fresh account |
| Concurrent double delete | two taps / two devices | db test | lock + `deletedAt` → 404 | one success, one silent 404 |
| Mobile delete request | offline / 500 | Jest | toast, stay, re-enable | clear error, can retry |
| Mobile child delete | child claimed since | Jest | 403 toast | clear error |
| Sole league admin deletes | league admin-less | service test (log line) | logged; runbook checklist | nothing; ADMIN repairs |

No failure mode is untested, unhandled **and** silent.

## Worktree parallelization

| Step | Modules touched | Depends on |
| --- | --- | --- |
| A. Schema + helpers + error base (D2, D11, D12) | `backend/prisma`, `backend/src/utils`, `backend/src/services/{team,guardian}-service`, `backend/src/index.ts` | — |
| B. AccountService + routes + guards (D3–D10, D14, D16, D17) | `backend/src/services/{account,workos,notification,player}-service`, `backend/src/api/{auth,players,teams}` | A |
| C. Seed, script, runbook, CLAUDE.md | `backend/prisma/seed.ts`, `backend/scripts`, `docs/runbooks` | B (script imports the service) |
| D. Mobile screen, menu, roster status, hooks, i18n, Jest, Maestro | `mobile/app`, `mobile/hooks`, `mobile/utils`, `mobile/i18n`, `.maestro` | B's API contract (can start from the plan) |

Lane 1: A → B → C (sequential, shared `backend/`). Lane 2: D (mobile) can start against the
contract in this plan once A+B are on a branch, in its own worktree; it merges as PR 2 after PR 1.
No module overlap between lanes; `CLAUDE.md` is touched by both, merge PR 1 first.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~2 h / CC: ~10 min)** — backend schema — add `User.deletedAt`, migration, schema test, `deletedAt` in `USER_SUMMARY_SELECT`
  - Surfaced by: D2, D14 (18A)
  - Files: `backend/prisma/schema.prisma`, `backend/prisma/migrations/<ts>_user_deleted_at/`, `backend/src/services/team-service.ts`
  - Verify: `npm run prisma:migrate` on the seeded local DB; `npm test -- schema`
- [ ] **T2 (P1, human: ~3 h / CC: ~15 min)** — backend utils — `lastHeadCoachTeams` (one query, `activeSeasonsOnly`) + `promoteNextPrimary`; refactor `assertNotLastHeadCoach` and `removeGuardian`
  - Surfaced by: Code quality 5A, Performance 9A, outside voice #3 (15A)
  - Files: `backend/src/utils/permissions.ts`, `backend/src/services/team-service.ts`, `backend/src/services/guardian-service.ts`, `backend/tests/utils/permissions.test.ts`
  - Verify: existing team-service / teams / guardian-service suites green unchanged
- [ ] **T3 (P1, human: ~2 h / CC: ~10 min)** — backend errors — `DetailedError` base, `LastHeadCoachError`, handler passthrough, remove `teams/routes.ts:75` copy
  - Surfaced by: Code quality 6B
  - Files: `backend/src/utils/errors.ts`, `backend/src/index.ts`, `backend/src/api/teams/routes.ts`, error-handler test
  - Verify: five 402 suites green; new handler test
- [ ] **T4 (P1, human: ~2 days / CC: ~50 min)** — backend service — `AccountService.deleteAccount` (guardian re-check under lock, league rename/delete, invitedEmail sentinel, admin-less league log) + `exportUserData` + `WorkOSService.deleteUser`, `DELETED_USER_NAME`
  - Surfaced by: D1–D8, D10, D16–D18, Architecture 1A/3A/4A, outside voice #2/#4/#5/#7
  - Files: `backend/src/services/account-service.ts`, `backend/src/services/workos-service.ts`, `backend/tests/services/account-service.test.ts`
  - Verify: service suite; db integration suite (T7)
- [ ] **T5 (P1, human: ~1 day / CC: ~20 min)** — backend routes + guards — `DELETE /auth/me`, `DELETE /players/:id/account`, `guardianOf.isManaged`, D9 guards on `PATCH /me`, `/me/role`, `registerToken` **and both `syncUser` branches**, dev-token + `dev-users` guards, D14 picker filters
  - Surfaced by: Architecture 2A, Follow-up 11C, outside voice #1 (13A) and #6
  - Files: `backend/src/api/auth/{routes,middleware}.ts`, `backend/src/api/players/routes.ts`, `backend/src/services/{workos,player,team,notification,guardian}-service.ts`, `shared/types/index.ts`
  - Verify: `tests/api/{auth,players,teams}.test.ts`, `tests/services/workos-service.test.ts`
- [ ] **T6 (P1, human: ~half day / CC: ~10 min)** — backend seed + script — tombstone sweep, `BRYCE_JAMES_ID` child + member + Gloria link upserted by id, `scripts/data-subject-request.ts`
  - Surfaced by: Seed / fixtures, Code quality 7A, outside voice #8, D7
  - Files: `backend/prisma/seed.ts`, `backend/scripts/data-subject-request.ts`
  - Verify: `npx prisma db seed` twice in a row is idempotent; `npx tsx scripts/data-subject-request.ts export mike.brown@example.com`
- [ ] **T7 (P1, human: ~1 day / CC: ~35 min)** — backend integration — `tests/integration/account-deletion.db.test.ts` (all cases in Tests)
  - Surfaced by: Test review 8A, outside voice #1/#3/#4/#5
  - Verify: `npm test -- account-deletion.db` against docker-compose Postgres
- [ ] **T8 (P1, human: ~half day / CC: ~15 min)** — docs — `docs/runbooks/data-subject-requests.md` (incl. post-deletion checklist, vendor windows), CLAUDE.md, e2e plan sections, #25 comment (corrected D8), follow-up issue for true erasure
  - Surfaced by: Docs, Follow-up 10A, D15, D18, outside voice #10 (20A)
  - Verify: Stop hook silent; links resolve
- [ ] **T9 (P1, human: ~2 days / CC: ~50 min)** — mobile — `app/account/delete.tsx`, `hooks/useAccount.ts`, Profile row + My kids `ActionMenu`, `'deleted'` roster status + chip, `utils/display-name.ts`, i18n (`account.delete.*`, `account.deletedUser`), Jest suites
  - Surfaced by: Mobile section, Test review 8A, outside voice #6 (18A)
  - Files: `mobile/app/account/delete.tsx`, `mobile/app/(tabs)/profile.tsx`, `mobile/hooks/useAccount.ts`, `mobile/utils/{roster-status,display-name}.ts`, `mobile/i18n/locales/{en,es}.json`, `mobile/__tests__/**`
  - Verify: `npm run lint && npm run type-check && npm test` in `mobile/`
- [ ] **T10 (P1, human: ~half day / CC: ~15 min)** — mobile E2E — `.maestro/account-delete.yaml`, `.maestro/guardian-child-delete.yaml` (incl. the Deleted chip on the Lakers roster)
  - Surfaced by: Tests
  - Verify: `npx prisma db seed && maestro test .maestro/account-delete.yaml` (and the child flow) on the dev client

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | CLEAR (PLAN) | 31 issues (9 review + 10 outside voice + 12 test gaps folded), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** outside voice (Claude subagent, fresh context, same model family — Codex not installed) raised 10 findings; 7 accepted (13A syncUser guard, 14A guardian re-check under lock, 15A active-season scope for the head-coach block, 16A personal-league rename/delete, 17A invitedEmail scrub, 18A Deleted roster chip + localized label, 20A truthful retention statement), 1 rejected (19B: no `last_league_admin` block — the person cannot clear it themselves), 2 folded as plan-text corrections (#8 seed reset path, #9 `RefreshToken` is a dead table). It agreed the shape is minimal (no simpler approach).
- **VERDICT:** ENG CLEARED — ready to implement (PR 1 backend, then PR 2 mobile).

NO UNRESOLVED DECISIONS
