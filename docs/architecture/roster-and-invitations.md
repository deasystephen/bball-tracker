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
  - **Case 1** (no email): managed `User` + `TeamMember`, one transaction. `rostered: true`.
  - **Case 2** (email with no *claimed* account — includes reusing an **unclaimed** pre-provisioned
    row, `workosUserId` null; `managedById` set only if null, name/role never touched): managed
    `User` (`isManaged: true`, `managedById` = coach — deliberate authz statement, B2.10 edit
    rights until claim) + `TeamMember` + `TeamInvitation` in one transaction, "added" email copy.
    **The player is on the roster immediately**; accept only activates their login.
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
  look up case-insensitively and create with `trim().toLowerCase()` — a mixed-case entry
  must never create an unclaimable duplicate or bypass the case-3 consent branch.
- **Every "which row holds this email" filter is `utils/email-match.ts#emailEquals(address)`
  (#572) — never a hand-written `{ equals, mode: 'insensitive' }`.** Prisma compiles that filter
  to `ILIKE` with the value as an **unescaped pattern**, so `_` matched any character and `%` any
  run: a lookup for `first_last@x.com` also returned the account `firstXlast@x.com`, and an
  invitation, a staff role or a guardian link could land on a stranger. `emailEquals` escapes
  `\`, `_` and `%`. It covers `User.email` (Add Player, guardian
  find-or-create, add staff by email, SES events) and `GuardianInvitation.invitedEmail`
  (pending list, account deletion, export). `tests/utils/email-match-guard.test.ts` fails on the
  raw filter anywhere else in `src/`; `contains` + `insensitive` (search) stays allowed.
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
- **`POST /teams/:id/invitations` takes `{ playerId }` only (#418).** It invites an existing user
  and, with `supersede`, is Resend. The `{ name, email }` create-and-invite arm (audit #69) is
  gone: `createInvitationSchema` requires `playerId` and strips unknown keys, so a body without
  it is a 400 and `name` / `email` sent next to a `playerId` are ignored. A new player, with or
  without an email, is created only by `POST /teams/:teamId/players`, which keeps the
  one-transaction rule (no orphan player when the invite fails).
- **Public route rate limit (audit #36).** `GET /invitations/by-token/:token` uses `invitationTokenRateLimit`
  (30 / 15 min, keyed by **token** via `invitationTokenKey`) because `hooplings.com/invite/<token>` is
  rendered server-side and every lookup arrives from the web server's single egress IP. The accept `POST`
  stays on the IP-keyed `writeRateLimit` (the browser calls it directly).
- Mobile expiry copy comes from `utils/invitation-expiry.ts` (`formatInvitationExpiry` /
  `isInvitationExpired`, timestamp compare — no `Math.ceil` → `-0` "Expires today" on a dead invite, #59).

### Mobile roster & invite-status chips (roster/invite unification)

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
  mutates Xander, so re-seed first).
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
