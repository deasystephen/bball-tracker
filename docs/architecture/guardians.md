# Guardians (PARENT role)

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Guardians / PARENT role (`services/guardian-service.ts`)

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
  The dedupe check and the insert are not one transaction, so a lost race on the partial index (a
  double-tapped Invite) maps P2002 → 400 `A pending guardian invitation already exists for this email`
  (`utils/prisma-errors.ts#createOrConflict`, targeted at that index, so a token collision still
  propagates), never 500 (#727).
  The Resend (supersede) transaction waits on the child/adult row locks; a waiter Prisma aborts (P2028, 5 s interactive-transaction timeout) is thrown as an `expected` `TransactionTimeoutError` (`prisma-errors.ts#lockWaitExpected`) and answered by `respondWithError` (which `POST …/guardians` uses; the central handler does the same for `next(err)`) as a retryable 503 with `Retry-After` and code `transaction_timeout`, never 500 (#908). Nothing was written, so the user can safely retry. Expected contention: logged at `warn`, not sent to Sentry. See `roster-and-invitations.md` for the scoping.
  The response carries the per-send `emailSent`; `hooks/useGuardians.ts#useInviteGuardian` resolves with
  `{ invitation, emailSent }` and the Guardians screen shows an error toast instead of "Invitation sent"
  when it is `false`, like the roster flows (#770). That toast, and the Add Player toast for a failed
  guardian email, say Resend becomes available in a couple of minutes: the cooldown below is keyed on the
  row just created whatever its send outcome, so Resend answers 429 until the window passes.
- **Resend = supersede (#420).** The same route with `{ email, relationship, supersede: true }` (Zod default
  `false`) skips both unlocked pre-checks (the link read and the dedupe 400) and runs
  `GuardianService.resendInvitation`. **Scope is the caller team's lineage** (the club across seasons; a
  `Team` row is one team-season), so after a rollover last season's pending row is still this club's to
  resend. It looks the adult's account up by `emailEquals` once. When the address has no account yet it runs
  two read-only refusals **before** creating the PARENT row: the cooldown, and the cross-lineage dedupe (a
  live PENDING row for the child + address on a team outside the lineage answers the plain invite's 400). So
  a resend refused by the cooldown or the dedupe provisions no account. The plain invite path still
  find-or-creates the account before its dedupe; that ordering is unchanged. With the adult's id known before
  the transaction, ONE `$transaction` then:
  1. takes `lockUsers(tx, [childId, parentId])` first, the same single id-ordered lock accept takes (#664),
     so an accept cannot commit between the link read and the expire;
  2. reads the `Guardian` link under that lock and answers 400 `This person is already a guardian of this
     player` when the parent accepted first;
  3. re-checks the cooldown and the cross-lineage dedupe (the authoritative checks; the pre-checks only spare
     the account create);
  4. lazily expires any **lapsed** PENDING row for the child + address on **any** team (`expiresAt <= now`,
     the plain invite's lazy expiry), so a lapsed row elsewhere never blocks the insert;
  5. expires the **live** PENDING row for the child + address on a team of the **caller's lineage**
     (`team: { lineageId }`), so another club cannot expire this club's invitation and re-issue it under
     theirs;
  6. creates the replacement with a new token, so the old link dies and a failed create never leaves the
     parent with no invitation.

  Every address filter in this path (cooldown read, dedupe read, both expires) is `emailEquals`. The
  inviter's name is read only after the row is committed. Logs `Guardian invitation superseded` (ids,
  `supersededCount`, `lapsedCount`) when a row was expired, and `Guardian invitation sent` carries
  `supersede`. Two concurrent resends for one child queue on the child lock: the first sends, the second then
  sees the new row and answers the cooldown 429. A row another club commits under the resend (a plain invite
  takes no row locks) still collides on the partial PENDING index, which `createOrConflict` (targeted at that
  index) maps to the dedupe 400, never 500; a token collision still propagates. **Cooldown:** the shared
  `utils/resend-cooldown.ts#assertResendCooldown` (window `INVITATION_RESEND_COOLDOWN_MS`, 2 minutes, the same
  helper and window as team invitations' #715 cooldown). When the newest `GuardianInvitation` for the child +
  address **within the caller's lineage** (any status, any season) is younger than the window the request
  answers **429** `resend_cooldown` ("An invitation was just sent to this address…") before anything is
  expired or mailed, and logs `Guardian invitation resend refused (cooldown)`. Another club's invitation to
  the same address never triggers it (the dedupe answers that case). Only the supersede path has the
  cooldown.

  **`canResend` and mobile.** `GET …/guardians` lists the child's pending invitations from every team, each
  with a server-derived `canResend`: true when the caller has `canManageRoster` and the row's team shares the
  caller team's lineage (a row whose team was deleted has none, so `false`). The Guardians screen renders a
  Resend icon (`guardian-resend-<id>`, label "Resend invitation: <email>") from that flag, never by comparing
  team ids; another club's row is listed without the action. Resend sends the row's own `invitedEmail` and
  `relationship` through the same `useInviteGuardian` hook as Invite; the form button follows its own
  `inviting` flag and the row in flight shows a spinner (disabled, `busy`), so neither action's pending state
  shows on the other's control. The API lists only unexpired PENDING rows, so Resend never targets a lapsed
  one. Proven against Postgres in `tests/integration/guardian-supersede.db.test.ts` (expire + create,
  cooldown, refused resends creating no account for both the cooldown and the dedupe, the accept that commits
  first, two concurrent resends, another club's resend and listing, the rollover resend, a lapsed row on
  another team, the partial-index collision answering 400).
- **Accept.** The public routes are polymorphic: `GET /invitations/by-token/:token` returns
  `invitation.kind: 'team' | 'guardian'` (guardian view: `childName`, `childDeletedAt`, `teamName`,
  `inviterName`, `inviterDeletedAt`, `relationship`, `status`, `expiresAt`; the two `…DeletedAt` fields are
  ISO strings or `null`, the tombstone signals for the names, #813, and the `guardianInvitations` items on
  `GET /invitations` have the same shape) and `POST /invitations/by-token/:token/accept` returns
  `{ kind: 'guardian', invitation, guardian }` — acceptance creates the `Guardian` row inside one
  `$transaction` guarded by `updateMany … WHERE status = 'PENDING'` (loser of a race gets 400).
  **Per-child lock (#664):** every writer of `isPrimary` holds the child's `User` row while it decides
  primacy. Accept takes `utils/user-row-lock.ts#lockUsers(tx, [childId, parentId])` as its first
  statement, before the invitation write: one `SELECT … WHERE "id" IN (…) ORDER BY "id" FOR NO KEY
  UPDATE`. `removeGuardian` takes `lockUsers` on the child and only then reads the link, so `isPrimary`
  is current. Account deletion locks its own row and every child it guards in its first statement
  (`… OR "id" IN (SELECT "childId" FROM "Guardian" WHERE "parentId" = $1) ORDER BY "id" FOR UPDATE`).
  Primacy is a count-then-insert, so without the lock two accepts for one child both counted 0 and both
  inserted `isPrimary`, and an accept racing the primary's removal could insert a non-primary link while
  the removal found nobody to promote. All rows a transaction needs are locked in one id-ordered
  statement, which is a global order: two adults each accepting to guard the other wait instead of
  deadlocking. `FOR NO KEY UPDATE`, not `FOR UPDATE`, so a foreign-key insert naming the child (a live
  game's `GameEvent`, a `TeamMember`) never waits on an accept. There is no partial unique index on
  primacy; the lock is the enforcement. Proven in `tests/integration/guardian-accept.db.test.ts` (lock
  waits read from `pg_locks`, the end states, the mutual accept, the unblocked FK insert).
  Authenticated `POST /invitations/:id/accept|reject` try the id as a `GuardianInvitation` first and require
  the caller's email to match `invitedEmail` (403 otherwise); responses carry `kind` too. Reject is guarded
  by the same `status = 'PENDING'` predicate as accept (#726), as one conditional `update({ where: { id,
  status: 'PENDING' } })` whose P2025 is the lost race: a reject that loses to a concurrent accept answers 400 `Cannot reject invitation: it is no longer pending` instead of overwriting
  `ACCEPTED` under a live `Guardian` link (the unlocked status read still answers the more specific
  `Cannot reject invitation with status: X` in the common case). **Which account
  the link lands on (#663):** the authenticated path uses the verified caller's id as `parentId` and never
  looks the adult up by email again; the by-token path resolves the adult exactly as invite time did,
  `findFirst({ email: emailEquals(invitedEmail), deletedAt: null })`, and only when nothing matches
  creates the PARENT account, with the same P2002 catch-and-reuse as `inviteGuardian`. Accept therefore
  never creates a second account for an address that already has one in a different case (`User.email`
  is byte-unique only; `syncUser` stores the address as given, and `POST /players` lower-cased only
  from #651). Proven against
  Postgres in `tests/integration/email-match.db.test.ts` (Guardian invitations). **Tombstones (#643):**
  the parent is resolved before the transaction, unlocked, so the transaction locks the row (the
  `lockUsers` statement above, `FOR NO KEY UPDATE`) and answers 404 `Account not found` when the row is
  gone or carries `deletedAt` under the lock. It is a write lock, not push-token registration's `FOR SHARE`, because the same
  transaction may update the row: two concurrent accepts by one parent holding share locks deadlocked
  on the upgrade; now they serialise; the `PARENT` promotion is `updateMany({ where: { id,
  deletedAt: null } })` and zero rows aborts the transaction, so no `Guardian` row ever points at a
  tombstone.
- **Other guardian routes.** `GET …/guardians` → `{ guardians: [{ id, userId, name, deletedAt, email?, relationship,
  isPrimary, createdAt }], pendingInvitations }` (roster managers or the child's guardians; `email` only for
  roster managers; each pending row carries `canResend`, see Resend above). `DELETE …/guardians/:guardianUserId` (roster manager, or the guardian removing themself).
- **What a guardian can do.** `utils/permissions.ts`: `isGuardianOf(userId, childId)`,
  `isGuardianOfTeamMember(userId, teamId)`; `canAccessTeam` is true for a guardian of any current member and
  `getTeamPermissions` returns `canViewStats: true` only (so schedule, live games, box scores, season stats —
  the member read set; roster emails stay stripped; no stat tracking / roster / announcements → 403).
  `POST /games/:id/rsvp { status, playerId? }` — `playerId` is allowed when the caller is a guardian of that
  player and the player is rostered on the game's team; the `GameRsvp` row is keyed on the **player** and the
  confirmation email goes to the guardian. The response row is the child's, projected like
  `GET /games/:id/rsvps`: no `user.email` unless the guardian also has `canManageRoster` (#661).
  Team invitations addressed to a child may be accepted/rejected by a guardian, `GET /invitations`
  default scope includes the caller's children, and `listInvitations?playerId=` accepts a child id. `NotificationService.sendToTeam` adds guardians of members (deduped). `PATCH
  /players/:id` lets a guardian change the child's `name` / `profilePictureUrl` (not `email`; jersey stays on
  the coach-only team-member route). `GET /auth/me`, `/auth/callback` and `/auth/dev-login` add
  `user.guardianOf: { childId, childName, childDeletedAt, relationship, isPrimary, isManaged, teams: { id, name }[] }[]`
  (`childDeletedAt` is the ISO tombstone signal for `childName`, #813).
  `isManaged` is true only for a managed child with no login (`isManaged && workosUserId === null`), the
  only record a guardian may delete (`DELETE /players/:id/account`, see `account-deletion.md`); `teams`
  lists the child's current team memberships and drives the Profile "Manage guardians" deep link
  (`/teams/:teamId/players/:playerId/guardians`).
- **List scoping (mobile PR).** `TeamService.listTeams` and `GameService.listGames` add
  `{ members: { some: { playerId: { in: childIds } } } }` (via `GuardianService.getChildIds`) to the caller-access
  `OR`, so a guardian's Teams / Games / Home tabs show the children's teams. `GET /invitations` (no `teamId` /
  `playerId`, status unset or `PENDING`) also returns `guardianInvitations: PublicGuardianInvitation[]` — the
  caller's pending, unexpired `GuardianInvitation`s matched on `invitedEmail` case-insensitively
  (`GuardianService.listPendingForUser`), no token — which the mobile Invitations tab renders as "Accept for <child>".
- Tests: `tests/services/guardian-service.test.ts`, `tests/api/guardians.test.ts`,
  `tests/utils/permissions.test.ts`, `tests/schemas/guardian.test.ts`,
  `tests/integration/guardian-supersede.db.test.ts`, guardian cases in the rsvp /
  invitation / notification / player-service / auth suites. Out of scope (v1): claim-by-code, parent-to-parent
  invites, `respondedBy` on RSVPs.
