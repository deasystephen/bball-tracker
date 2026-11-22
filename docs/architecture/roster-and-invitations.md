# Roster, Add Player and team invitations

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Team Invitations & Unified Add Player (roster/invite unification)

Spec: `docs/plans/roster-invite-unification-spec.md` (unified Add Player; decisions D1–D5 +
eng-review amendments recorded there).

- **`POST /teams/:teamId/players`** (gate `canManageRoster`) is the unified Add Player call —
  name required, `playerEmail?`, `guardianEmail?` + `guardianRelationship?`, jersey/position/photo.
  It replaced `POST /teams/:id/managed-players` and the `{name,email}` arm of
  `POST /teams/:id/invitations`, both **removed in #418** once the request logs showed no
  traffic to either: the first now answers 404, the second 400 (`playerId is required`). Do not
  add a tombstone for them. The unified path itself previously answered 410 — that tombstone was
  deleted deliberately. Consent model:
  - A supplied `profilePictureUrl` is gated before any case runs: `assertOwnUploadUrl(url, coachId)`
    rejects (400) a managed-bucket URL that is not the coach's own upload, checked on the parsed
    path (#717, rule in `backend-services.md`, Avatar uploads).
  - **Case 1** (no email): managed `User` + `TeamMember`, one transaction. `rostered: true`.
  - **Case 2** (email with no *claimed* account — includes reusing an **unclaimed** pre-provisioned
    row, `workosUserId` null; `managedById` set only if null, name/role never touched): managed
    `User` (`isManaged: true`, `managedById` = coach — deliberate authz statement, B2.10 edit
    rights until claim) + `TeamMember` + `TeamInvitation` in one transaction, "added" email copy.
    **The player is on the roster immediately**; accept only activates their login. A row that
    holds a staff role (an accepted staff invitation not yet signed in, #460) is never reused this
    way: it goes to case 3. On a reused
    row a supplied `profilePictureUrl` is written only when the row has none (a second
    `updateMany` guarded on `profilePictureUrl: null` inside the transaction, so a race cannot
    overwrite); when the row keeps its own photo the upload is discarded after commit with
    `discardOwnAvatar`, as in case 3 (#618).
  - **Case 3** (email belongs to a claimed account, `workosUserId` set): invitation **only** —
    membership on accept (pre-consent membership = de facto auto-accept, deferred by D2).
    `rostered: false` in the response; `guardianEmail` is refused with `guardianInvited: false` +
    reason (guardian system requires membership). A supplied `profilePictureUrl` is discarded
    server-side (`upload-service.ts#discardOwnAvatar`, best-effort, inside `createCase3Invitation`
    so every path into case 3 is covered): the mobile app uploads the photo before the request and
    a claimed account keeps its own, so the object would otherwise be orphaned in S3 (#419). The
    delete only touches keys under `avatars/<callerId>/` because the URL is client-supplied and a
    coach must not be able to delete another user's avatar.
  - Unique-email races: `user.create` P2002 is caught and retried once against the winner row
    (`resolveEmailRaceWinner`).
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
  PENDING row (live or lapsed) and creates a fresh one (new token — the old link dies) in one
  transaction, in the same code path as create. The superseding row **inherits
  `jerseyNumber`/`position`/`message` from the newest row for the pair, only when that row is
  PENDING or EXPIRED**, when the request omits them (mobile Resend sends only
  `{ playerId, supersede }`) — a case-3 accept creates the member row from the live invitation, so
  a bare resend must not wipe the coach-set jersey (jersey-loss fix 2026-08-29); explicit values
  still win. A PENDING row, when one exists, is always the newest (at most one exists and nothing
  is created after it), so it is the row being superseded. EXPIRED counts because an "Invite
  expired" row may already have been flipped, by the player opening the dead link (#678). A newest
  row that is CANCELLED or REJECTED means the coach or the player ended it, so a resend after it
  inherits nothing and an older row is never revived. Under `supersede` `assertInvitable` no
  longer lazy-expires a lapsed row before the transaction, so the transaction expires it and logs
  `Invitation superseded`.
- **Resend cooldown (#715):** both expire-and-recreate paths, Resend (supersede) and Add Player case 2
  re-adding a removed player's address, run `latestAfterCooldown` inside their transaction, which
  applies the shared `utils/resend-cooldown.ts#assertResendCooldown`. When
  the newest invitation row for the pair (any status, so a Cancel between resends does not reset
  it) is younger than `INVITATION_RESEND_COOLDOWN_MS` (2 minutes, in the same file) **and went to the address the
  player still has**, the request answers **429** `resend_cooldown` (`ResendCooldownError`, body
  `{ error, code, retryAfterSeconds }`) before anything is expired or mailed, and logs
  `Invitation resend refused (cooldown)` with ids only. Every invitation row is one email, so this
  caps one address at one message per window. The address an invitation went to is stored as
  `TeamInvitation.recipientHash` (`hashRecipient()`, set at creation on every path); a changed
  address skips the cooldown, so "Fix email address → Save & send invitation" goes out at once. A
  row from before the column existed has a null hash and counts as the same address; a player
  with no address gets no email, so no cooldown. Account deletion clears the hash on the deleted
  user's invitation rows. Guardian invitations have the same Resend and the same helper and window
  (#420, keyed on child + address within the club's team lineage; `docs/architecture/guardians.md`). On top of it the email-sending roster routes share the per-user
  `inviteRateLimit` (60 / hour; see `docs/architecture/backend-services.md`, Rate limits). With `supersede` an existing **member** is allowed (a rostered case-2 player);
  a claimed account that is already a member answers 400 `Player already has access to this team`.
  Resend/"Invite" actions must only target PENDING rows client-side. Expiry-check and insert are
  not one transaction, so a lost create race on the partial unique index (double-tap resend) maps
  P2002 → 400 `A pending invitation already exists for this player` (`createInvitationRow`), never 500.
  The supersede transaction waits on that index's row lock; if the holder is slow and the waiter is cancelled (PostgreSQL `lock_timeout`, or Prisma's P2028 5 s interactive-transaction timeout), `respondWithError` (and the central handler, for `next(err)`) answers a retryable **503** with `Retry-After` and code `transaction_timeout` (`TransactionTimeoutError`, a `DetailedError`), never 500 (#908). Nothing was written, so the user can safely retry (mobile mutations have `retry: 0` and only show the error toast). The genuine double-tap resolves in milliseconds and ends as the P2002 → 400 above, so a lock wait that times out means the lock holder itself is slow: the 503 is logged at `error` and captured like any other, and the on-call runbook treats it as a slow-database signal. Every pooled connection carries `lock_timeout = 4000ms` (`models/pool-config.ts#DB_LOCK_TIMEOUT_MS`, a pg startup option, #944; the per-transaction `SET LOCAL` from #908 is gone). Without it Prisma's 5 s transaction timeout only stops Prisma waiting while the statement stays blocked in PostgreSQL, pinning a pool connection until the holder commits and letting each retry add a waiter. 4 s is under the 5 s timeout so PostgreSQL cancels first (SQLSTATE 55P03, which Prisma 7 with the pg adapter surfaces as P2039 for ORM queries and P2010 for raw ones, with the code on `meta.driverAdapterError.cause.code`) and the connection is freed; the remaining second covers the reads before the first lock. `models/pool-config.ts#classifyDbError` maps 55P03 and a P2028 expiry to the same 503; `maxWait` exhaustion answers the pool-busy 503 and a query on an already closed transaction stays a 500. `tests/integration/invitation-supersede.db.test.ts` holds the row lock on one connection and proves the cancel. The mobile api-client skips its Sentry capture for any 503 carrying `Retry-After`, which reaches users with the next OTA after this change, so the mobile project is quiet only once that OTA is out. `createInvitationRowSuperseding` runs through `createOrConflict` targeted at the partial index, so a token-collision P2002 propagates; the same test file pins the 400 against the live driver-adapter meta shape.
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
  look up case-insensitively and create with `trim().toLowerCase()` — a mixed-case entry
  must never create an unclaimable duplicate or bypass the case-3 consent branch. `POST /players`
  and `PATCH /players/:id { email }` follow the same rule since #651: the schema trims and
  lower-cases, and the duplicate probe is `emailEquals`.
- **Every "which row holds this email" filter is `utils/email-match.ts#emailEquals(address)`
  (#572) — never a hand-written `{ equals, mode: 'insensitive' }`.** Prisma compiles that filter
  to `ILIKE` with the value as an **unescaped pattern**, so `_` matched any character and `%` any
  run: a lookup for `first_last@x.com` also returned the account `firstXlast@x.com`, and an
  invitation, a staff role or a guardian link could land on a stranger. `emailEquals` escapes
  `\`, `_` and `%`. It covers `User.email` (Add Player, guardian
  find-or-create, add staff by email, SES events), `GuardianInvitation.invitedEmail`
  (pending list, account deletion, export) and `StaffInvitation.invitedEmail` (dedupe, supersede,
  the invitee's pending list, export; #460). `tests/utils/email-match-guard.test.ts` fails on any
  innermost object literal in `backend/src/` or `backend/scripts/` (`.ts`, `.js`, `.mjs`) outside the
  helper that pairs `equals` with an explicit `mode`, whatever its value: the `'insensitive'` literal,
  `Prisma.QueryMode.insensitive`, a constant or the shorthand (#696). Outside `emailEquals` there is no
  reason to pair the two. `contains` + `insensitive` (search) stays allowed. A filter assembled across
  statements, and `startsWith` / `endsWith` + `insensitive`, are not checked.
  **Proven only against real Postgres** (`tests/integration/email-match.db.test.ts`): each flow
  plants a look-alike account and must not touch it. When adding such a test, put the `_` on the
  side that is the **query** — the look-alike on the wrong side passes with the bug present
  (caught by mutation-testing the suite). That suite also fails if a future Prisma starts
  escaping by itself, which would make addresses containing `_` stop matching.
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
  activate your access") vs default "invited to join" (case 3).
- `POST /teams/:id/invitations` (staff with `canManageRoster`) creates a `TeamInvitation` with a random
  `token` and emails the player a `hooplings.com/invite/<token>` link. The token is a **bearer secret**:
  `POST /invitations/by-token/:token/accept` is unauthenticated and accepts on behalf of the invited player.
- **The token is never returned on an authenticated response** (audit #14). `invitation-service.ts` reads
  invitations back through explicit `select` constants (`INVITATION_SCALAR_SELECT` / `INVITATION_SELECT` /
  `INVITATION_TEAM_SELECT`) that omit `token`, and `api/invitations/serializers.ts#omitToken` strips it again
  at the route layer as defense in depth. Only `getInvitationByToken` / `acceptInvitationByToken` (the
  public routes, where the caller already holds the token) touch it. The public by-token lookup and accept wrap
  both kinds (team and guardian) in `omitToken` too (#766). Tests in `tests/api/invitations.test.ts`,
  `tests/api/teams.test.ts` and `tests/services/invitation-service.test.ts` assert `token` is absent from
  create/list/get/accept/reject/cancel; `tests/api/invitation-transitions.test.ts` drives accept, reject,
  cancel and by-token accept through the real service and proves the select and `omitToken` separately
  (the lookup's `omitToken` too).
  Do not add `include`-based invitation queries.
- **`GET /invitations?playerId=<other user>`** (role matrix B2.4): allowed for system ADMINs (unscoped);
  for guardians of the player (`isGuardianOf`, unscoped; see `guardians.md`);
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
  other callers with team access (rostered players) remain scoped to `playerId IN (caller, caller's
  children)` via `GuardianService.getChildIds` (see `guardians.md`).
  `GET /invitations/:id` keeps its `canAccessTeam`-or-invited-player gate and applies the roster-email
  rule to `player.email` (#679): the invited player and callers with `canManageRoster` receive it;
  every other reader, a guardian of the invited player included, gets the player without `email`
  (`omitRosterManagerFields`, so `deletedAt` stays). `invitedBy.email` is a staff email and
  stays for every reader.
- **`POST /teams/:id/invitations` takes `{ playerId }` only (#418).** It invites an existing user
  and, with `supersede`, is Resend. The `{ name, email }` create-and-invite arm (audit #69) is
  gone: `createInvitationSchema` requires `playerId` and strips unknown keys, so a body without
  it is a 400 and `name` / `email` sent next to a `playerId` are ignored. A new player, with or
  without an email, is created only by `POST /teams/:teamId/players`, which keeps the
  one-transaction rule (no orphan player when the invite fails).
- **Public route rate limit (audit #36).** `GET /invitations/by-token/:token` uses `invitationTokenRateLimit`
  (30 / 15 min, keyed by **token** via `invitationTokenKey`) because `hooplings.com/invite/<token>` is
  rendered server-side and every lookup arrives from the web server's single egress IP. For the same
  reason the lookup is **exempt from the global IP-keyed `apiRateLimit`** (`skipGlobalApiLimit`, #718):
  otherwise the web server's 101st `/api/v1` call in a minute would turn every invite page into the
  "Invitation Temporarily Unavailable" card (the web page shows that card, with no resend advice, for any
  429, 5xx or failed lookup, and "Invitation Not Found" only for a 400 or 404; #720). It keeps a looser per-IP ceiling of its own, `invitationLookupIpRateLimit`
  (`INVITATION_LOOKUP_IP_MAX_PER_15_MIN` = 600 / 15 min), because the token key alone would let a
  loop of random tokens reach the database unbounded. The accept `POST` stays on the IP-keyed
  `inviteAcceptRateLimit` and `apiRateLimit` (the browser calls it directly).
- Mobile expiry copy comes from `utils/invitation-expiry.ts` (`formatInvitationExpiry` /
  `isInvitationExpired`, timestamp compare — no `Math.ceil` → `-0` "Expires today" on a dead invite, #59).

### Staff invitations by email (#460, club coach onboarding)

`POST /teams/:teamId/staff` still adds an **existing** account only (404 for an unknown address,
with code `staff_target_not_found` since #460 so the app can offer an invitation instead). It refuses
(400 `staff_target_needs_invitation`) an unclaimed **managed** roster record, named by address or by id:
its managing coach could rewrite that email (B2.10) and claim the role, so such an address is invited
instead (the app offers the invitation on either code).
`services/staff-invitation-service.ts` invites any address to a staff role through a
**`StaffInvitation`** row, the third invitation kind next to `TeamInvitation` and
`GuardianInvitation`. It reuses the same machinery rather than copying it: a random bearer-secret
token read back only through `STAFF_INVITATION_SELECT` / `STAFF_INVITATION_LIST_SELECT` (no `token`,
no `recipientHash`) and stripped again by `omitToken` at every route; lazy expiry; Resend =
supersede in one transaction; a hand-written partial unique index
`StaffInvitation_pending_teamId_invitedEmail_key ON (teamId, invitedEmail) WHERE status = 'PENDING'`
(migration `20261115120000_staff_invitation`, mapped to a 400 by `createOrConflict`); `emailEquals`
for every address match and the address stored trimmed and lower-cased; the shared
`assertResendCooldown` window; awaited sends bounded at 5 s with a per-send `emailSent` flag.

- **Why a separate table, not a nullable `TeamInvitation.playerId`.** `TeamInvitation` rows are
  player invitations everywhere they are read (`GET /invitations`, the roster chips, the case-3
  "Invited" section, old app builds that dereference `invitation.player`); a staff row in that
  table would reach all of them. A new kind, like the guardian one, is invisible to every reader
  that does not ask for it.
- **The consent rule (claim-by-email hazard).** `WorkOSService.syncUser` claims any `User` row
  holding an address with a null `workosUserId` on the first sign-in with that address, so a
  pre-provisioned row is a standing grant of whatever hangs off it. **Invite time creates no
  `User` row**: the invitation holds only the address and the role type. The account (when the
  address has none) and the `TeamStaff` row are created **on accept**, by the person holding the
  emailed link or signed in with the address. A new account is `COACH` for a coaching role and
  `PLAYER` (the default, so the app's role step asks) for a team manager, not managed,
  `emailVerified: false`, named with the email local part (the placeholder the app's one-time name
  prompt replaces) and `ageConfirmedAt` null (the age screen runs at its first sign-in, and a staff
  row is an adult signal for the under-age branches, `children-and-age.md`). An account whose staff
  row after the accept is a coaching one (head or assistant coach; for an account already on the
  staff, its own row) is made `COACH` from `PLAYER` or `PARENT`: the global role gates team
  creation. A team-manager row promotes nothing.
- **`POST /teams/:teamId/staff-invitations { email, roleType, supersede? }`** (`inviteRateLimit`).
  Gate: **`canManageStaff`**, the predicate `POST /staff` uses (head coach, league admin, system
  admin; an assistant coach gets 403). `roleType` is `HEAD_COACH | ASSISTANT_COACH | TEAM_MANAGER`
  (`staffRoleTypeSchema`), resolved to the team's default role (404 when the team lacks it). Refused
  before anything is written: team 404, 403, role 404, 400 `This person is already a staff member of
  this team` when the address belongs to a live account on the team's staff. Then one transaction
  that locks the inviter's `User` row and then the team row (`lockTeamRow`, the lock every staff
  mutation takes; account deletion's user-then-team order, so the two cannot deadlock): a team-season that
  is not its lineage's latest (`latestTeamSeasonId`, #461) answers 400 (invite the team's current
  season); a live PENDING row for the team + address answers 400 `A pending staff invitation already
  exists for this email` unless `supersede`; the `canManageStaff` gate is checked again behind the lock
  (a head coach removed meanwhile, whose invitations that removal cancels under the same lock, cannot
  slip one in after it); on **every** create the cooldown reads the newest row for the address's
  `recipientHash` within the team's **lineage** (so a rollover, which moves only PENDING rows, does
  not reset it; any status, so a cancel or a decline, whose hash outlives its stripped
  address, does not reset it) and answers 429 `resend_cooldown`. Team invitations get the same cap
  from supersede alone because a player's address lives on the `User` row; here only the invitation
  rows know it, so cancel-and-reinvite would otherwise email the address at once. A role correction
  waits the 2 minutes. Then lapsed PENDING
  rows (and with `supersede` the live one, so the old link dies) are flipped to EXPIRED; the new row
  is created (7-day expiry). 201 `{ invitation, emailSent }`. Template:
  `services/mailer/templates/staff-invitation.ts`, link `${PUBLIC_APP_URL}/invite/<token>`; when the
  address already belongs to a claimed account or a managed record (`acceptInApp`), the email says to
  open the link in the app signed in with the address, since the public accept refuses it.
- **`GET /teams/:teamId/staff-invitations`** lists the team's pending, unexpired rows (with
  `invitedEmail` and `invitedBy { id, name, deletedAt }`) to `canManageStaff` callers only (403
  otherwise: an invitee's address is not a staff email until they accept).
  **`DELETE /teams/:teamId/staff-invitations/:invitationId`** cancels (same gate; 404 for another
  team's id, checked after the 403 so a non-manager learns nothing about ids; a status-guarded
  update, so a cancel that loses to an accept is a 400). Cancel keeps the address, like the player
  flow.
- **Accept, three paths.** `GET /invitations` (no `teamId`/`playerId`, status unset or PENDING)
  carries `staffInvitations` for the caller: pending, unexpired rows whose address `emailEquals` the
  account's, as `{ kind: 'staff', id, status, teamName, roleType, inviterName, inviterDeletedAt,
  expiresAt }` (no token, no address). `POST /invitations/:id/accept|reject` try the id as a
  guardian invitation, then a staff invitation (the caller's email must match `invitedEmail`, 403
  otherwise; a declined or scrubbed row has no address to match and reads as no staff invitation,
  so the fall-through answers 404), then a team invitation. The public `GET /invitations/by-token/:token` falls through
  team → guardian → staff and returns the same `kind: 'staff'` view; `POST …/by-token/:token/accept`
  accepts it. Accept answers `{ kind: 'staff', invitation, staff, alreadyStaff }` (the by-token
  answer trims `invitation` to `{ id, status }` and `staff` to `{ teamId, roleType }`: a forwarded
  link never reveals the invited address, the inviter's id or the account's id, name or email) and invalidates the account's usage cache. With `alreadyStaff` the web page and
  the app say the role was not changed.
  - **Which account:** the verified caller on the authenticated path (never a second lookup by
    address); by token, the live account holding the address (`emailEquals`) **only if nobody has
    signed in to it**, else a new one,
    created **inside the accept transaction** with a native `INSERT … ON CONFLICT ("email") DO
    NOTHING` and the same lookup, so a refused or failed accept leaves no account behind and two
    concurrent accepts converge on one row. **By token, a claimed account or an unclaimed *managed*
    roster record holding the address is refused 409 `sign_in_required`** (`SignInRequiredError`):
    a forwarded link must not put a role (and a global role change) on someone's login, and a
    managed record's coach may still rewrite its email (`PATCH /players/:id`, B2.10) and take the
    role by pointing it at their own address. The invitee signs in with the address (which claims a
    managed row) and accepts in the app. The check runs again on the row
    read **after** the transaction's row lock, and Add Player's adoption locks the same row before
    its guarded update, so an adoption racing the accept either commits first (409 here) or waits
    and then sees the staff row (case 3).
  - **The transaction** reads the invitation's team again under the team lock (a season rollover
    that committed after the unlocked read moved the row onto the new team-season; the accept then
    locks and uses that one, and a dead-invitation cancel is guarded on the team it checked), and
    locks the account's `User` row, then the `Team` row (account deletion's
    order: user first, teams after), so a tombstone never gets a staff row (404) and the accept
    serialises with staff removal and re-role; **re-checks that the inviter is a live account that may
    still manage the team's staff** (`deletedAt` null and `canManageStaff(invitedById)` behind the
    lock; 400 otherwise; `isSystemAdmin` alone would pass a deleted ADMIN's tombstone), so a head coach
    who is removed, demoted or deleted after sending cannot come back through an invitation sent to
    an address they control, and a club that changes head coach re-sends (removing or demoting a head
    coach also cancels the PENDING staff invitations they sent on that team, in the same transaction,
    when `canManageStaff` no longer holds for them, so a league or system admin keeps theirs); refuses
    an invitation whose team-season is no longer its lineage's latest (the staff row would land on
    last season's team; a season rollover moves the team's PENDING staff invitations onto the new
    team-season, and cancels the ones whose sender cannot manage the new team-season's staff, so
    this catches only an invitation that slipped past that); and in both of those cases cancels the row after the rollback
    (`Staff invitation cancelled` with a `reason`), so it stops showing as pending. A team that no
    longer has the invited default role answers 400. It then flips PENDING → ACCEPTED
    guarded on the status (the loser of a race gets 400); and creates the `TeamStaff` row with the
    invited role **unless the account already holds one**, which is left unchanged
    (`alreadyStaff: true`). Accepting never re-roles, so it can never demote the last head coach.
    `POST /staff` takes no team lock, so a direct add racing the accept can hit
    `TeamStaff_teamId_userId_key`; that P2002 rolls the accept back and answers 400 (a retry finds
    the row and reports `alreadyStaff`).
- `GET /invitations/:id` reads team invitations only (guardian and staff ids answer 404 there, as
  before for guardians); the app never fetches a staff invitation by id.
- A lazily expired staff invitation logs `Staff invitation expired`.
- **Rejection strips the address** (the rejection-only strip of the player flow): the invitee's
  decline sets `invitedEmail` to the per-row sentinel `deleted-<id>@invalid` in the same guarded
  update (the sentinel and the raw-SQL scrub share `utils/stripped-email.ts`); `recipientHash`
  stays, so the cooldown still applies to a re-invite. Cancel and expiry
  keep the address. With no `User` row created at invite time there is nothing else to strip.
- **A staff role's email is not the managing coach's to rewrite.** `PATCH /players/:id { email }`
  answers 403 for a non-admin when the row holds any `TeamStaff` row, checked before the write and
  again in the write's `where` (`teamStaff: { none: {} }`): with the email pointed at their own
  address, signing in would claim the row and its role. This is the root guard; the ones below keep
  such rows from arising.
- **An accepted-but-unclaimed staff account stays unmanaged.** Add Player's case 2 never adopts a
  row that holds a `TeamStaff` row (`teamStaff: { none: {} }` on its claim-guarded `updateMany`):
  it re-branches to case 3 like a claimed account, because a managing coach could otherwise rewrite
  the row's email (B2.10) and claim the staff role. For the same reason a player-invitation
  rejection never strips the address of a row that holds a staff role (`stripUnclaimedEmail`).
  Proven in `tests/integration/staff-invitation.db.test.ts`.
- **Account deletion and the under-13 un-claim** expire every PENDING staff invitation to the
  address and scrub `invitedEmail` (sentinel) and `recipientHash` on every one, in
  `account-service.ts#scrubInvitedEmail` (D17, with the guardian invitations). Deleting an account
  also cancels the PENDING staff invitations it sent. The data-subject
  export carries `staffInvitations` (sent to the address) and `sentStaffInvitations`; sent staff
  invitations that are not CANCELLED are an adult signal.
- **App builds that predate staff invitations** never list one (`staffInvitations` is a key they
  do not read). Opened from a link, their deep-link screen treats any `kind` other than `guardian`
  as a team invitation: it shows "join <team>" without a role and its Accept calls
  `POST /invitations/:id/accept`, which accepts the staff invitation correctly (the response's
  `kind: 'staff'` is ignored). The web page (`web/app/invite/[token]/`) renders the role.
- **Mobile.** The staff screen (`app/teams/[id]/staff.tsx`) turns the add's 404 `staff_target_not_found`
  or 400 `staff_target_needs_invitation` (only those codes: a gone team is a 404 too) into an offer: the hint "No account uses that email yet" and
  a **Send invitation** button (`useInviteStaff`, `emailSent: false` is an error toast, never silent).
  The offer holds only while the field shows the address the 404 was for. Callers who may manage staff
  see **Pending invitations** (`useStaffInvitations`, requested only for them) with Resend (the same call
  with `supersede: true`, after a confirm, because it kills the invitee's link) and Cancel
  (`useCancelStaffInvitation`, confirm dialog); a staff removal or re-role refreshes that list too (it can
  cancel a head coach's invitations). Home's invitations bell counts staff and guardian invitations. A
  staff accept re-reads `GET /auth/me` for the role (a coaching row makes the account a COACH, which shows
  "Create team"). The Invitations tab
  renders `staffInvitations` cards (Accept / Decline), and the deep-link screen renders `kind: 'staff'`
  (team and role rows; the sign-in hint asks for the address the invitation was sent to). Role labels come from
  `utils/staff-role.ts`. Accept invalidates teams, games, staff and usage. Events: `staff_invited`,
  `staff_invitation_cancelled`, and `invitation_accepted` with `kind: 'staff'`. Maestro:
  `.maestro/staff-invitation.yaml` (invite and cancel on the Lakers; the seed deletes every Lakers
  staff invitation).
- Tests: `tests/api/staff-invitations.test.ts` (route → real service → Prisma mock),
  `tests/schemas/staff-invitation.test.ts`, `tests/integration/staff-invitation.db.test.ts`
  (no `User` row at invite, the partial index and its reported name, the `first_last` look-alike,
  account creation, the managed-record refusal, two concurrent accepts, the strip, deletion),
  `web/__tests__/invite-page.test.tsx`.

### Team join links (#210, self-serve roster onboarding)

A coach shares ONE link per team (group chat, or a QR code at practice) and families add
themselves. `services/join-link-service.ts`, routes in `api/join/routes.ts` (by token) and
`api/teams/routes.ts` (team-scoped), schemas in `api/join/schemas.ts`.

- **Decision: a link lets a signed-in adult ASK; a roster manager approves.** The link names
  nobody and is posted where it can be forwarded, so holding it grants nothing: `POST /join/:token`
  creates a PENDING `TeamJoinRequest` and writes no roster row, and the requester cannot read the
  team (`canAccessTeam` is false) until a caller with `canManageRoster` approves. The issue's
  original "auto-join" was dropped because a member reads the roster, which is mostly children's
  names. The alternative (auto-join, relying on expiry and revoke alone) is a change to
  `requestToJoin` only; the tables would not change.
- **Who can ask** (accounts are adults, `children-and-age.md`): `{ kind: 'self' }`, the account
  holder joins as a player; or `{ kind: 'child', childName, relationship }`, a parent adds their
  child. Nothing else about a child is accepted (the schema strips an email, an age, a date of
  birth).
- **Tables** (migration `20261122120000_team_join_link`, additive): `TeamJoinLink { teamId, token,
  createdById?, expiresAt, maxUses?, useCount, revokedAt? }` and `TeamJoinRequest { teamId, linkId,
  requesterId, kind SELF|CHILD, childName?, relationship?, status, decidedAt? }`. `status` reuses
  `InvitationStatus` (PENDING, ACCEPTED = approved, REJECTED = declined, EXPIRED = lapsed, below). A new kind in its own
  tables, like staff invitations, so no existing invitation reader sees it.
- **The token is a bearer secret**, `randomBytes(32).toString('base64url')` like the invitation
  tokens. It is read only through `JOIN_LINK_MANAGER_SELECT` and leaves the API only inside
  `link.url` (`${PUBLIC_APP_URL}/join/<token>`) on the two roster-manager routes below; there is no
  `token` field on any response, the team payload never carries the link, and no log line carries
  the token (`utils/redact.ts` masks the segment after `/join/`, for the API route and the web
  page). **A revoked link answers 404 like an unknown one**, on the preview and on the request, so
  a rotated link tells its holder nothing.
- **`POST /teams/:teamId/join-link { expiresInDays?, maxUses? }`** (`canManageRoster`): creates
  the link and revokes the live one in the same transaction, behind the creator's `User` row lock
  and then the team row lock (account deletion's order), so create **is** rotate and a team never
  has two live links (proven with three concurrent creates). `canManageRoster` is checked again
  behind that lock, here, on revoke and on approve (`hasTeamPermission(…, tx)`, which now takes a
  transaction client like `canManageStaff`), so a coach removed while the call was in flight gets
  403. **Every link expires**: 14 days by
  default (`JOIN_LINK_DEFAULT_EXPIRES_DAYS`), 1 to 30 on request; `maxUses` is 1 to 500 or `null`
  (no cap, the default). 201 `{ link: { id, teamId, url, expiresAt, maxUses, useCount, createdAt } }`.
- **`GET /teams/:teamId/join-link`** (`canManageRoster`): the live link (not revoked, not expired)
  or `link: null`. A link at its cap is still returned so the coach sees why nobody can use it.
  **`POST /teams/:teamId/join-link/revoke`**: revokes every live link, `{ revoked }`, behind the
  same team row lock as create, so a revoke racing a create waits and then revokes the link that
  create inserted. Pending requests stay for the coach to decide.
- **`GET /join/:token`** (public): `{ link: { teamName, state } }`, `state` one of `active`,
  `expired`, `full`. No roster, no coach, no counts, no team id. Logs `Join link viewed` (`linkId`,
  `state`, `client`). Like the invitation lookup it is exempt from the global IP limit
  (`skipGlobalApiLimit`) and has its own `joinLinkLookupIpRateLimit` (600 / 15 min per IP).
  **There is deliberately no per-token budget** (the invitation lookup has one): a join link is
  shared with a whole team, so a token-keyed limit would let one holder, or a link-preview bot in
  the group chat, lock every other family out of the page.
- **`POST /join/:token`** (`authenticate`, so the age gate applies; `joinRequestRateLimit`, 20 /
  hour per account). 404 for an unknown token. Then one transaction behind the requester's
  `User` row lock; the account is read again after the lock and must still be a live login
  (`deletedAt` null and not `isManaged`), so a request cannot slip in behind an account deletion or
  an under-age un-claim (401, never the link's 404):
  - **Idempotent, before the link's state is judged.** An account already on the roster, or a
    child of that name the account already guards on the team, answers 200 `{ status:
    'already_member', teamId, teamName }` and writes nothing. A request already waiting (the SELF
    one, or a CHILD one of the same name) is returned as it is, 200 `created: false`. Both hold
    when the link has since filled, expired or been rotated, so a retry after a lost response is
    never told to ask the coach for a new link. Names are compared in code, trimmed,
    whitespace-collapsed and case-folded (no SQL pattern match).
  - **Only a new request needs a live link:** 404 when revoked (like an unknown one), **410
    `join_link_inactive`** (`JoinLinkInactiveError`, `reason: 'expired' | 'full'`) otherwise.
  - **Cap:** at most `MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT` (6) requests per account and team
    that are pending or were declined (`decidedAt`) in the last 30 days, 400 beyond. Declined ones count so that
    an account told "no" cannot keep asking (each ask is a push to the coaches and a use of the
    link); approved ones never count.
  - **One use of the link**, taken by a single conditional `UPDATE … SET "useCount" = "useCount" + 1
    WHERE not revoked AND not expired AND ("maxUses" IS NULL OR "useCount" < "maxUses")`, so
    `maxUses` holds under concurrency (zero rows → 404 or 410 from a re-read). The comparison is
    made in UTC (`NOW() AT TIME ZONE 'UTC'`), as the columns are stored. **`maxUses` counts
    requests, approved or not.**
  - The PENDING row. 201 `{ status: 'pending', created: true, teamName, request: { id, kind,
    status, createdAt } }` (no team id: a requester is not a member yet).
  After commit: `Join request created` (ids and `kind`) and a best-effort push to the team's staff
  whose role has `canManageRoster`, the requester excepted ("Someone asked to join <team>", no
  person's name; data `{ type: 'join_request', teamId }`). A failed push is a warn, never a failed
  request.
- **A request nobody decides lapses after `JOIN_REQUEST_TTL_DAYS` (30).** It is flipped to EXPIRED
  and its `childName` cleared, **lazily**: when the team's list is read and when the requester asks
  again (nothing in the API is scheduled, as with invitation expiry), in a statement of its own
  that commits before the ask is judged, so a refused ask never undoes it; an approve or decline of a
  lapsed row that was not flipped yet answers 400. So a family is never stuck at the pending cap.
  The typed name of a request on a team whose coaches never open the list, from a requester who
  never returns, stays until one of those reads happens or the account is deleted.
- **`GET /teams/:teamId/join-requests`** (`canManageRoster`, 403 otherwise): the pending requests,
  oldest first, each with `childName`, `relationship` and `requester` (`USER_SUMMARY_WITH_EMAIL_SELECT`:
  the address is how a coach recognises who is asking; roster managers already see roster emails).
- **`POST /teams/:teamId/join-requests/:requestId/approve`** writes the roster in one transaction:
  locks the requester and the approver (`lockUsers`, one id-ordered statement), then the team row
  (the lock staff removal and re-role take) and checks `canManageRoster` again behind it (403 for
  a coach removed while the call was in flight), reads the requester again as a live login (400
  when deleted or un-claimed meanwhile), flips PENDING →
  ACCEPTED guarded on the status (the loser of two approvals, or of approve against decline, gets
  400) and clears `childName`. **SELF:** `teamMember.upsert` with `update: {}` for the requester.
  **CHILD:** what Add Player's case 1 plus an accepted guardian invitation produce: a managed
  `User` (`isManaged`, no email, no login, `managedById` = the approving coach), its `TeamMember`
  and the `Guardian` link to the requester (`isPrimary`, the record's first), and a bare PLAYER
  requester becomes PARENT (`GuardianService.promoteBareAccountToParent`, the guardian accept's
  rule, now shared). Logs `Join request approved`; best-effort push to the requester ("You have
  been added to <team>", or "Your child has been added to <team>" for a child request; none when
  the approver is the requester).
  **`…/decline`**: one status-guarded update, `childName` cleared, nothing written to the roster,
  no notification. Order of refusals on both: team 404, 403, request 404 (another team's id), 400.
- **Not built (deliberate):** approving a CHILD request always creates a new roster record. When
  the coach already added that child, decline the request and use "Invite a parent" on the existing
  row (`guardians.md`); linking a request to an existing record is a follow-up. A requester cannot
  list or withdraw their own requests. A link is not moved by a season rollover: it stays on the
  team-season it was created for.
- **Account deletion and the under-age un-claim** delete every `TeamJoinRequest` the account sent
  (`purgeLoginBindings`), so a sign-up that only asked to join is erased outright; `deleteAccount`
  also sets `createdById` to null on the links the account created (the link stays live: every
  request through it is approved by a current roster manager). Both relations are in
  `USER_REFERENCE_COUNT_SELECT`. The data-subject export carries `joinRequests` and
  `createdJoinLinks` (never a token).
- **Mobile.** `hooks/useJoinLink.ts` holds every call. The team screen shows roster managers a
  **Share join link** button (`team-join-link`; "Join link · N requests" while requests wait, from
  `useJoinRequests`, which is requested only for them). `app/teams/[id]/join-link.tsx` shows the
  explanation, the QR code of `link.url` (`components/QrCode`), **Share link** (React Native's
  `Share`, the system sheet, which has Copy; there is no clipboard module in the binary), **New
  link** and **Turn off** (each behind a confirm whose button reads differently from the screen's,
  "Create new link" / "Turn off link"), and the pending requests with Approve and Decline icons
  (Decline confirms); each request shows who would be added, who asked, and the asker's email on
  a line of its own. Requests come from other phones and a link can be replaced from another coach's, so
  `useJoinRequests`, `useJoinLink` and the public `useJoinLinkPreview` never trust their cache
  (`staleTime: 0`, `refetchOnMount: 'always'`), and this screen polls the link and the requests
  every 15 s (`JOIN_LINK_POLL_MS`) and has pull-to-refresh. **Whether a link is live is the
  server's answer, never the device clock's** (a phone whose clock runs ahead must not be offered
  "Create join link", which revokes the live one). A re-read that fails keeps what is on screen
  (the QR code, the rows); the full-screen and inline errors show only when nothing was loaded. The URL is never printed as text. A link is created with the server
  defaults (14 days, no cap); the app has no control for either yet. A caller without
  `canManageRoster` gets an `ErrorState` and neither query runs.
  **The QR code** is `utils/qr-path.ts`: `qrcode-generator` (plain JavaScript, no native code, so
  it ships by OTA and the drift guard does not list it) computes the matrix at error-correction
  level M, and one `react-native-svg` `<Path>` of horizontal runs draws it, always black on white
  with a 4-module quiet zone. `__tests__/utils/qr-path.test.ts` compares the path with the
  library's matrix module by module and checks the three finder patterns.
  `app/join/[token].tsx` is the deep-link screen (`hooplings://join/<token>`, and the Universal
  Link `https://hooplings.com/join/<token>` on iOS): the public preview (`/join/` is in
  `PUBLIC_PATHS`), then for a signed-out visitor "Log In to Continue" with `/join/<token>` stored
  as the return path (it survives sign-in and the age screen), and for a signed-in one "Who is
  joining?" with **Me** / **My child** (`SortPills`, nothing preselected), the child's name and
  `RelationshipChips`. A new request shows "Request sent" (and "Add another child" for a parent);
  an account already on the team is sent to it. Expired, full and unknown links each have their
  own screen; a network failure, 429 or 5xx is a retry, never the dead-link screen. Sentry's
  redaction masks the segment after `/join/` (`services/sentry.ts`), in the custom-scheme deep
  link too (`hooplings://join/<token>`, where `join` sits in the host position; the same fix covers
  `hooplings://invite/<token>`). Events: `join_link_created`,
  `join_link_revoked`, `join_request_sent`, `join_request_approved`, `join_request_declined` (ids
  and enums; never the link, its token or a name). Android App Links for `/join/` need
  `android.intentFilters`, which is native config: they wait for the next binary; the custom
  scheme works today.
- **Web.** `web/app/join/[token]/page.tsx` renders the preview server-side
  (`lib/join-lookup.ts`, `X-Hooplings-Client: web`) and offers only **Open in App**
  (`hooplings://join/<token>?src=web`, `lib/open-in-app.ts#openJoinInApp`, the same App Store
  fallback as the invite page). Nothing can be accepted on the web: asking needs a signed-in
  adult. A 400/404 is "Join Link Not Found", a 429/5xx/failed fetch "Temporarily Unavailable"
  (logged as `Join link lookup unavailable`, reason and status only). `lib/log.ts` masks the
  segment after `/join/`. `public/.well-known/apple-app-site-association` lists `/join/*` next to
  `/invite/*`, so iOS hands the https link to the app.
- **Maestro:** `.maestro/join-link.yaml` (a parent asks through the seeded Lakers link, Frank
  approves, then replaces the link; needs `SEED_MAESTRO_INVITE_TOKEN=true npx prisma db seed`,
  which writes the fixed `MAESTRO_JOIN_TOKEN` into a local database only). Every seed deletes the
  Lakers' join links and requests and writes one fresh link. Written for this change and **not
  yet run**.
- Tests: `tests/api/join-links.test.ts` (route → real service → Prisma mock, every gate and
  answer, no token on any body or log line), `tests/schemas/join-link.test.ts`,
  `tests/integration/join-link.db.test.ts` (one live link under concurrent creates, no access
  while pending or after a decline, `maxUses` under concurrency, expired and revoked, the retry
  after the last use, the lapse, an un-claimed requester, both approval kinds, two concurrent
  approvals, deletion). The revoke-against-create race is argued from the shared lock, not
  reproduced in a test. Mobile: `__tests__/hooks/useJoinLink.runtime.test.tsx`,
  `__tests__/app/join-request.test.tsx`, `__tests__/app/team-join-link.test.tsx`,
  `__tests__/utils/qr-path.test.ts`. Web: `web/__tests__/join-page.test.tsx`.

### Mobile roster & invite-status chips (roster/invite unification)

- `app/teams/[id]/players.tsx` has ONE **Add Player** form (`useAddRosterPlayer` →
  `POST /teams/:teamId/players`): name required, optional player email (invite goes out when
  present), optional parent email + relationship chips (guardian invite in the same step,
  rostered cases only). The old "Create New Player" / "Add Roster Player" split and
  `useAddPlayerToTeam` are gone. Result handling: `rostered: false` (existing account) toasts an
  explanation; `emails.player/guardian === false` toasts an error (never silent);
  `guardianReason` surfaces as info.
- **Players under 13 (#982, part of #980 adults-only accounts; the whole posture and the age screen
  that enforces it server-side: `docs/architecture/children-and-age.md`).** Before the player-email field
  the form asks "Is this player 13 or older?" (Yes / No, `components/SortPills` with
  `accessibilityState.selected`, labelled "<question> <answer>" via `labelPrefix`). **No** hides the
  player-email field, clears anything typed in it, never sends a `playerEmail`, and makes the
  parent/guardian email required, with the "Players under 13 don't get their own login" note shown
  as its own text above the field (so an invalid-address error never hides it). The child stays a
  managed roster record and the parent gets the PARENT account (`docs/architecture/guardians.md`).
  **Yes** shows the field as before; the parent email stays optional. A typed email (player or
  parent) must be well formed or the submit stays disabled, before any photo upload; the error shows
  once the field loses focus. When the team's free-text `ageGroup` reads as a bracket that can hold
  an under-13 player (`utils/age-group.ts#isUnder13AgeGroup`: `U1`–`U13`, `1U`–`13U`, "Under 12",
  "12 & Under", plurals such as "U12s", Spanish "Sub-12" / "Menores de 12", ages in years whose
  top is 12 or less such as "Ages 8-10" or "10 & younger" (13 for "13 years and under", like
  "13 & Under"), K–6th grade in either order,
  Kindergarten, Pre-K, and ranges that start there such as "U12-U14") the question defaults to No.
  U14, 14U, Sub-14, 7th grade and "Ages 10-14" are deliberately left with no default.
  The question cannot be bypassed from the roster: the "Fix email address" sheet only corrects an
  address the player already has (it refuses a player with none), and "Send invitation" needs an
  address on file, so a player added without one is reached only through "Invite a parent". Otherwise it has
  **no** default, deliberately never Yes, and the submit stays disabled until it is answered: the
  explicit answer is what backs the Terms warranty (#25).
  **The answer is never sent to the API or stored**: a per-player under-13 flag would itself be age
  data about a child. The server does not enforce this (it cannot from free text; that needs
  structured age groups, #462); the hard stop is the first-sign-in age screen (#981). Maestro:
  the under-13 branch at the end of `.maestro/roster-management.yaml`.
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
- **"Email bounced" is a second chip, never a roster status (#449).** The team payload carries
  what SES reported for each rostered player's address (`player.emailSuppressedAt` /
  `emailSuppressedReason`, roster managers only — see `email.md`). Derive it
  ONLY via `utils/email-delivery.ts#getEmailDeliveryIssue(player)` (`'bounced'` | `'complaint'`
  | `null`; a tombstone or a player with no address is always `null`, and a reason this build
  does not know reads as `'bounced'`). It is orthogonal to the invite status — an Invited row
  can also be bounced — so the status chip stays where it is and a flagged row grows a strip
  underneath: the email chip (`"<player> email: Email bounced"` is the row-anchored label) and,
  on a line of its own, the full address. Keep the address on its own line — beside the chips it
  truncated to "xander.ex…" on a 393pt screen, and the typo is what the coach has to read. The
  menu's first item on such a row is **Fix email address**, offered only when
  `player.isManaged` (a claimed account's email belongs to its login): a bottom sheet that
  accepts only a different, well-formed address, sends it trimmed and lower-cased through
  `useUpdatePlayer` (`PATCH /players/:id { email }`, which now also invalidates
  `teamKeys.details()`), and then — when the row is Invited / Invite expired / Not invited —
  runs the same supersede create as Resend ("Save & send invitation"). The backend lets only
  the coach who **added** an unclaimed player change its email (B2.10), so a 403 is translated
  to "Only the coach who added … can change this email address". Tests:
  `__tests__/utils/email-delivery.test.ts`, `__tests__/app/players-email-issue.test.tsx`.
- Seeded chip fixtures on the Lakers (Iris Invited / Xander Expired / Wendy WebAccept /
  Marcus Johnson = Not invited; **Xander also carries a hard-bounced address**, and the seed
  restores his email and delivery state on every run). Maestro: `.maestro/roster-management.yaml`
  (add → immediate roster + chip), `.maestro/roster-invite-status.yaml` (all four chips + action
  gating) and `.maestro/roster-email-bounced.yaml` (email chip → fix → invitation re-sent;
  mutates Xander, so re-seed first). Every seeded invitation token is random except Iris's PENDING
  one, which carries the fixed `MAESTRO_INVITE_TOKEN` (`tests/support/seed-fixtures.ts`) for
  `.maestro/invite-deep-link.yaml` when the seed runs with `SEED_MAESTRO_INVITE_TOKEN=true` against a
  local, non-production database. The by-token routes' format check is
  `src/utils/invitation-token.ts#isValidInvitationTokenFormat`.
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
