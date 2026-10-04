# Account deletion (as built)

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Account deletion (#444, App Store 5.1.1(v); `docs/plans/account-deletion.md`)

- **Anonymize in place; erase outright only when nothing references the row.**
  `AccountService.deleteAccount(userId, { actorId, mode })` (`services/account-service.ts`) runs
  ONE `$transaction`: `SELECT … FOR UPDATE` on the user row → last-head-coach check → purge rows
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
  rows with it), guardian accept (`FOR NO KEY UPDATE` probe on the parent, a write lock because the
  same transaction may promote the row to `PARENT`; a share lock deadlocked two concurrent accepts by
  one parent) and Add Player case 2 (the reuse `updateMany` and photo fill carry `deletedAt: null`;
  zero rows on a tombstone is 404, on a claimed row the case-3 re-branch) plus
  `stripUnclaimedEmail`. A request that authenticated a moment before the deletion
  committed must not re-identify the tombstone. Keep that invariant on any new write path:
  `tests/utils/user-write-guard.test.ts` fails on any `user.update(`, `user.updateMany(`,
  `user.delete(`, `user.deleteMany(` or `user.upsert(` in `src/` whose `where` is not an object
  literal naming `deletedAt`. Only `account-service.ts` is allowlisted: it writes the tombstone,
  scrubs `managedById`, and hard-deletes an account nothing references, under its own `FOR UPDATE`
  lock. Real-Postgres cases: `tests/integration/account-deletion.db.test.ts`.
- Structured error bodies come from ONE place: `DetailedError.body()` (`utils/errors.ts`) —
  `{ error, code, ...details }` — used by the central handler in `index.ts` and by the entitlement
  402s; never hand-roll `{ code, … }` in a route.
- `deletedAt` rides on team-service's `USER_SUMMARY_SELECT` (rosters, staff, guardians, and the
  members and staff of `GET /games/:id`, which imports it) and on invitation-service's own
  `USER_SUMMARY_SELECT` (`player` and `invitedBy` on `GET /invitations` and `GET /invitations/:id`),
  so clients derive a "Deleted" chip and a localized label. Callers without `canManageRoster` get
  roster players through `team-service.ts#omitRosterManagerFields`, which removes only the email
  and its delivery state. Game event players use `game-event-service.ts#EVENT_PLAYER_SELECT`
  (`id`, `name`, `deletedAt`, no email) on the REST payloads and the `game-event` socket broadcast.
  The public `GET /invitations/by-token/:token` carries `inviterDeletedAt` next to `inviterName`
  (#642). Pickers (`listPlayers`, `getPlayerById`, staff lookup, `dev-users`, `dev-login`)
  filter tombstones out. `guardianOf[].isManaged` tells the app which
  child records a guardian may delete.
- Retention statement for #25 is in the runbook ("Retention"): tombstone keeps id/role/dates; stats
  retained de-identified; RDS backups 7 days; backend Sentry and Amplitude keep records keyed on
  the internal id for their windows (no name/email/photo), mobile Sentry carries no user id at
  all, and Amplitude also holds IP-derived city/region/country (#559). Seed: `mike.brown@example.com` (assistant coach, never
  blocked; his only row is the staff role, so his deletion **erases** the row) is the self-delete
  Maestro fixture; `BRYCE_JAMES_ID` (managed Lakers player, Gloria James as guardian; rostered,
  so his deletion tombstones) is the guardian child-delete fixture; the seed sweeps tombstones
  first and re-creates Mike by email.
- Tests: `tests/services/account-service.test.ts`, `tests/api/account-delete.test.ts`,
  `tests/integration/account-deletion.db.test.ts` (real Postgres: rollback, concurrency, guarded
  writes, export contract), `lastHeadCoachTeams` in `tests/utils/permissions.test.ts`.
