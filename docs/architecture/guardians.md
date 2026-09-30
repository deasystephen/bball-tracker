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
