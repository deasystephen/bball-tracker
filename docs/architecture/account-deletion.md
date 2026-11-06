# Account deletion (as built)

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Account deletion (#444, App Store 5.1.1(v); `docs/plans/account-deletion.md`)

- **Anonymize in place; erase outright only when nothing references the row.**
  `AccountService.deleteAccount(userId, { actorId, mode })` (`services/account-service.ts`) runs
  ONE `$transaction` (each lock wait below is bounded at 4 s by the pool-wide `lock_timeout`, `models/pool-config.ts`, #934/#944: a delete stuck behind a holder is cancelled by PostgreSQL and answers the retryable 503 `transaction_timeout`, writing nothing; two slow holders in a row can still reach Prisma's 5 s, same 503): `SELECT … FOR UPDATE` on the user row and every child it guards, in one
  id-ordered statement (#664, the guardian primacy lock; `docs/architecture/guardians.md`) → `SELECT … FOR NO KEY UPDATE` on every team where the user is HEAD_COACH, in one id-ordered statement (#463, the lock staff removal and demotion take; User before Team, `docs/architecture/authorization.md`) → last-head-coach check → purge rows
  that only serve the person → scrub personal data elsewhere → **count what still points at the
  row** → tombstone it (`workosUserId`/`email`/`profilePictureUrl` null, `name =
  DELETED_USER_NAME`, `deletedAt = now()`), or `delete` it when the count is zero (#529). The
  count is ONE `findUnique` with `USER_REFERENCE_SELECT` (`_count` of every list relation on
  `model User` plus `personalLeague`); `USER_OUTBOUND_RELATIONS` names the relations that point
  *from* the row (`managedBy`). A test in `tests/services/account-service.test.ts` parses
  `schema.prisma` and fails when `User` gains a relation named in none of the three, so **a new
  relation on `User` must be added to the select** (or declared outbound) — a missed one would
  let the hard delete cascade through rows other people rely on, which is what D1 forbids. The
  rule is "nothing references this row", never "no game events". `GameEvent`, `PlayerStats`,
  `TeamMember`, authored announcements and announcement replies stay so other members' stats and
  threads remain coherent, and any of them keeps the tombstone. The result carries `erased: boolean` (both routes and the operator
  script return it; the runbook's request log records it). After commit, best-effort: S3 avatar
  delete and `WorkOSService.deleteUser` (response `identityDeleted: false` on failure, Sentry
  `flow: account-delete`; the runbook finishes it in the dashboard). **Never read the tombstone
  state from `name`/`email` — `deletedAt` is the signal.**
- **Convert instead of delete (under 13, #983).** When we learn an account holder is under 13,
  the operator may turn the account back into a managed roster record instead of deleting it:
  `backend/scripts/convert-to-managed.ts <userId> [--coach <coachUserId>]` →
  `AccountService.convertToManaged` (no route). One `$transaction`:
  1. **Unlocked read** (`assertConvertible`): no live row is 404; an already-managed, unclaimed
     row is 409 "already a managed roster record", so a re-run never reaches the coach check.
     Then the **managing coach** is chosen: the `--coach` id or the single head coach, both staff
     on one of the player's teams in an **active** season. When no active-season team exists the
     409 says to delete instead; when one exists but has no head coach, it says to pass `--coach`;
     several head coaches is 409 too.
  2. **`SELECT … FOR UPDATE` on the player and the coach in one id-ordered statement**, the order
     and strength `deleteAccount` uses for a user and the children they guard, so the two can wait
     on each other but not deadlock. Then `assertConvertible` again, the coach must be live, and
     the coach choice is re-checked. FOR UPDATE on the player blocks the key-share lock a new
     `TeamStaff`, `LeagueAdmin`, `Guardian`, invitation, announcement or managed-player row naming
     it takes.
  3. **Adult signals in one read** (`ADULT_SIGNALS_SELECT`, `_count`s plus the personal league's
     admin and per-season team counts), judged by the pure `assertPlayerAccount`. 409 for: the
     global `ADMIN` role (a refusal signal, not an access check; `COACH` is not a signal, a child
     can self-select it), a staff row, a guardian-of link, managed players, announcements authored,
     sent team or guardian invitations that are not `CANCELLED`, admin of any league but its own
     personal league, or a personal league with teams or another admin. An empty personal league
     is deleted by `deleteEmptyPersonalLeague` (D16, shared with `deleteAccount`).
  4. **`unclaimManagedRow(tx, lockedRow, managedById)`**, exported for the age screen's under-13
     branch (#981).
     - **Deleted** (collected from the child): `workosUserId`, `email` (with
       `EMAIL_SUPPRESSION_CLEARED`) and `emailVerified`; announcement replies the child wrote (the
       only free text a player authors; the schema holds no chat or messages);
       `purgeLoginBindings` (push and calendar-feed tokens, pending team invitations `CANCELLED`,
       `recipientHash` cleared); the photo unless it is an upload under the `avatars/<id>/` prefix
       of the coach or another live staff member of the player's active-season teams (external
       URLs are cleared too, since the identity provider's photo is copied at claim time; a
       cleared photo in our bucket is deleted from S3 whoever uploaded it, unless another `User`
       row still references the URL); and the address on every guardian invitation that carries
       it, any status, any child (`scrubInvitedEmail`, D17, shared with `deleteAccount`), after
       every PENDING one is expired. The PENDING ones for this child at the child's own address
       are returned as `expiredGuardianInvitationIds`, because accepting one would create a PARENT
       account at the child's address.
     - **Reset:** `isManaged` true, `managedById` the coach, role `PLAYER`, free tier.
     - **Kept** (team records): memberships, game events, stats, RSVPs, `Guardian` links (an
       accepted link survives the scrub of its invitation's address), and guardian invitations for
       the child at other addresses.

  After commit, best-effort: the S3 avatar delete and `WorkOSService.deleteUser`. The result's
  `identityDeleted` is `true`, `null` (no identity) or `false`. On `false`: Sentry `flow:
  convert-to-managed`, then `WorkOSService.revokeAllSessions` (one client, `Promise.allSettled`,
  `{ revoked, failed }`); the result carries `workosUserId` and `sessions`, and the script exits 3.
  Open Socket.io connections are not closed: they last until their access token expires, the same
  as after `deleteAccount` (#1004). Domain event `Account converted to managed` (`userId`,
  `actorId`, `managedById`, `identityDeleted`, `deletedReplyCount`). Procedure:
  [`docs/runbooks/data-subject-requests.md`](../runbooks/data-subject-requests.md#we-learned-an-account-holder-is-under-13);
  real-Postgres cases: `tests/integration/convert-to-managed.db.test.ts`.
- Routes: `DELETE /auth/me` (any user, ADMIN included — the allowlist re-promotes on re-signup) and
  `DELETE /players/:id/account` (guardian of a **managed, unclaimed** child only; the route
  pre-checks and the service re-checks under the lock). A claimed account is deletable only by its
  owner — never by guardians or ADMINs through the API; emailed requests go through
  `backend/scripts/data-subject-request.ts` (`export` / `delete <email>`, `operator` mode) per
  [`docs/runbooks/data-subject-requests.md`](../runbooks/data-subject-requests.md).
- **Last head coach blocks** with 400 `code: 'last_head_coach'` + `teams`, scoped to teams whose
  season `isActive` (a `Team` row is a team-season, so past seasons go headless rather than forcing
  a coach to delete history). The rule is `utils/permissions.ts#lastHeadCoachTeams` (one set-based
  query), shared with `TeamService.assertNotLastHeadCoach`; never re-implement it. A sole league
  admin is NOT blocked (they cannot appoint a replacement); the log line lists admin-less leagues.
- **Every write onto a `User` row is guarded by `deletedAt IS NULL`**: `PATCH /auth/me`,
  `PATCH /auth/me/role` (`updateMany` + re-read, 401 on zero rows), push-token registration (`FOR
  SHARE` probe inside the upsert transaction) and both `syncUser` branches (`updateMany`, fall
  through to create on zero rows). Since #643 also `PATCH /players/:id` (tombstone 404 for an ADMIN
  too; one `update` with `where: { id, deletedAt: null }`, P2025 is 404), `DELETE /players/:id`
  (tombstone 404 and a `delete` with the same guarded `where`; before, it hard-deleted the tombstone
  and the `onDelete: Cascade` relations such as `AnnouncementReply.author` silently took the retained
  rows with it), guardian accept (`FOR NO KEY UPDATE` on the parent, taken with the child in one sorted
  statement by `utils/user-row-lock.ts#lockUsers`, a write lock because the
  same transaction may promote the row to `PARENT`; a share lock deadlocked two concurrent accepts by
  one parent) and Add Player case 2 (the reuse `updateMany` and photo fill carry `deletedAt: null`;
  zero rows on a tombstone is 404, on a claimed row the case-3 re-branch) plus
  `stripUnclaimedEmail`. A request that authenticated a moment before the deletion
  committed must not re-identify the tombstone. Keep that invariant on any new write path:
  `tests/utils/user-write-guard.test.ts` fails on any `user.update(`, `user.updateMany(`,
  `user.delete(`, `user.deleteMany(` or `user.upsert(` in `backend/src/` or `backend/scripts/`
  (`.ts`, `.js`, `.mjs`) whose `where` is not an object literal naming `deletedAt`. Only `account-service.ts` is
  allowlisted: it writes the tombstone, scrubs `managedById`, and hard-deletes an account nothing
  references, under its own `FOR UPDATE` lock. No script is allowlisted: the operator CLI deletes
  through `AccountService.deleteAccount` and the lookup only reads; a script that ever needs a raw
  hard delete gets its own allowlist entry with a one-line reason. Real-Postgres cases: `tests/integration/account-deletion.db.test.ts`.
- Structured error bodies come from ONE place: `DetailedError.body()` (`utils/errors.ts`) —
  `{ error, code, ...details }` — used by the central handler in `index.ts` and by the entitlement
  402s; never hand-roll `{ code, … }` in a route.
- `deletedAt` rides on ONE shared user shape, `backend/src/utils/user-select.ts` (#813):
  `USER_SUMMARY_SELECT` (`id`, `name`, `isManaged`, `deletedAt`, no email) and
  `USER_SUMMARY_WITH_EMAIL_SELECT` (the same plus `email`). Every user embedded in a payload uses
  one of them: rosters and staff on `GET /teams/:id` and `GET /games/:id`, `player` and
  `invitedBy` on `GET /invitations` and `GET /invitations/:id`, staff and members on
  `GET /seasons/:id` and `GET /leagues/:id`, league admins, `user` on `GET /games/:gameId/rsvps`,
  `author` on announcements and replies, guardian rows on the guardians list (flattened as `deletedAt`
  next to `name`), the guardian links in the data-subject export, and the box-score and season-stats player (flattened as
  `playerDeletedAt` next to `playerName`; `GET /stats/players/:id` returns the `player` object). So
  clients derive a "Deleted" chip and a localized label. The email variant goes only where the
  email rule in `authorization.md` allows it (staff for every team member; roster `player.email`
  stripped for callers without `canManageRoster` by `team-service.ts#omitRosterManagerFields`,
  which removes only the email and its delivery state, and RSVP `user.email` by `toRsvpView`).
  Game event players use `game-event-service.ts#EVENT_PLAYER_SELECT`, an alias of
  `USER_SUMMARY_SELECT`, on the REST payloads, the `game-event` socket broadcast and the socket
  join snapshot. `tests/utils/user-select-guard.test.ts` fails on any `select` with `name: true`
  on a `User` relation key in `backend/src/` (the keys are read from `prisma/schema.prisma`: every field
  typed `User`, `User?` or `User[]`) that neither selects `deletedAt: true` nor spreads a `USER_SUMMARY`
  constant; a `select: SOME_CONSTANT` declared in the same file is checked through its body.
  The public `GET /invitations/by-token/:token` carries `inviterDeletedAt` next to `inviterName`
  for team invitations (#642) and guardian invitations, and so do the `guardianInvitations` items
  on `GET /invitations` (#813). Guardian invitations and `guardianOf` also carry `childDeletedAt` next
  to `childName`. Pickers (`listPlayers`, `getPlayerById`, staff lookup, `dev-users`, `dev-login`)
  filter tombstones out. `guardianOf[].isManaged` tells the app which
  child records a guardian may delete.
- Retention statement for #25 is in the runbook ("Retention"): tombstone keeps id/role/dates; stats
  retained de-identified; RDS backups 7 days; backend Sentry and Amplitude keep records keyed on
  the internal id for their windows (no name/email/photo), mobile Sentry carries no user id at
  all, and Amplitude also holds IP-derived city/region/country (#559). Seed: `mike.brown@example.com` (assistant coach, never
  blocked; his only row is the staff role, so his deletion **erases** the row) is the self-delete
  Maestro fixture; `BRYCE_JAMES_ID` (managed Lakers player, Gloria James as guardian; rostered,
  so his deletion tombstones) is the guardian child-delete fixture; the seed sweeps tombstones
  first and re-creates Mike by email. The sweep (`tests/support/seed-resets.ts#removeTombstones`, through
  `test-leftovers.ts#deleteUsersWhere`) deletes the invitations a tombstone sent before the
  tombstone, in one transaction: both
  `invitedById` foreign keys are `ON DELETE RESTRICT` and deletion keeps sent invitations (#783).
- Tests: `tests/services/account-service.test.ts`, `tests/api/account-delete.test.ts`,
  `tests/integration/account-deletion.db.test.ts` (real Postgres: rollback, concurrency, guarded
  writes, export contract), `lastHeadCoachTeams` in `tests/utils/permissions.test.ts`.
