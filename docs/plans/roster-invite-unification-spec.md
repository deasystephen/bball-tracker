# Roster / Invite Unification Spec (TeamSnap-style Add Player)

**Status:** Draft — decisions locked 2026-08-27, pending eng review
**Owner:** Stephen Deasy
**Context:** QA on 2026-08-28 (team "Spartans 5/6", 8 players via "Create New Player") surfaced that
invited players are invisible until they accept: the roster showed 0 players, pending invitations are
not rendered anywhere coach-facing, there is no resend/cancel UI, and invite emails failed silently
(SES sandbox). Comparison against TeamSnap's documented flow
([Add and Invite Roster Members](https://helpme.teamsnap.com/article/460-add-and-invite-roster-members),
[All About the Invitation Process](https://helpme.teamsnap.com/article/281-all-about-the-invitation-process),
[Add Family or Contacts to a Profile](https://helpme.teamsnap.com/article/108-add-family-or-contacts-to-a-profile))
showed our two-button model ("Create New Player" vs "Add Roster Player") diverges from the market
pattern on exactly the points that confused a real coach.

## Goals

1. **One Add Player flow.** Name required; player email optional; parent/guardian email optional;
   "Send invitation" applies whenever an email is present. Managed-vs-invited becomes an outcome,
   not an upfront decision.
2. **Every added player appears on the roster immediately**, with an inline invite-status chip.
3. **Coaches can see, resend, and cancel invitations** from the roster screen.
4. **Youth pattern:** a coach can enter a parent's email at creation; the parent gets a guardian
   invitation (existing guardian system) in the same step.

## Locked product decisions (2026-08-27)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Cancel/reject vs roster entry | **Player stays on roster.** Cancelling (coach) or rejecting (player) only ends the login-access invitation; the roster entry survives as an uninvited/managed player with a "Not invited" chip. Removing a player from the roster remains a separate, existing action. *Nuance:* invites sent to an **existing account** never create a roster entry pre-accept (see Consent model), so a reject there simply removes the "Invited" row. |
| D2 | Auto-accept for existing accounts | **Deferred.** Explicit accept stays in v1. Auto-accept (TeamSnap behavior) is a consent + account-enumeration question; record it as a follow-up decision when revisited. |
| D3 | Parent email at creation | **In v1.** The Add Player form takes an optional guardian email + relationship, creating a `GuardianInvitation` via the existing guardian system in the same operation. |
| D4 | Resend token handling | **Rotate.** Resend generates a new bearer token and fresh `expiresAt`; the old link dies. (Engineering decision, recorded here for the audit trail — tokens are bearer secrets, audit #14.) |
| D5 | Existing data | **Disposable.** Production contains test data only; no backfill or data migration is required. Reset + reseed is acceptable (see Rollout). |

## Consent model (the invariant everything hangs off)

- **New person (no existing account for the email, or no email at all):** create a managed `User`
  (+ email when given) **and a `TeamMember` row immediately**, in one `$transaction` — exactly the
  guarantee `addManagedPlayer` and create-and-invite (audit #69/#70) give today. This is safe
  without consent because a managed user cannot log in; the roster entry only makes them trackable,
  which is what the coach is asking for. The optional `TeamInvitation` (same transaction) gates
  *account claim/login*, not roster presence.
- **Existing account (email matches a `User` with `workosUserId`, or invite-by-playerId from
  search):** invitation **only** — no `TeamMember` until accept, because membership would grant
  that real account team access pre-consent (de facto auto-accept, which D2 defers). The roster UI
  renders these as "Invited" rows sourced from the pending-invitations list.
- **Claim path unchanged:** `syncUser` already links a pre-provisioned managed row by email on
  first WorkOS login. The invitation email is therefore a *notification + deep link*; accepting it
  transitions the invitation and routes the user into the claim flow. Accept must tolerate an
  already-existing membership (upsert/no-op) instead of inserting.

## Backend changes

### New unified endpoint

`POST /api/v1/teams/:teamId/players` (gate: `canManageRoster`; supersedes both
`POST /teams/:id/managed-players` and the `{name,email}` arm of `POST /teams/:id/invitations`):

```
{
  name: string,                       // required
  playerEmail?: string,               // optional; find-or-create semantics
  guardianEmail?: string,             // optional; requires relationship
  guardianRelationship?: GuardianRelationship,
  jerseyNumber?: number,              // 0 is valid — null-check, never truthiness
  position?: string,
  profilePictureUrl?: string
}
```

Behavior (single `$transaction` where rows are created):

1. No `playerEmail` → managed `User` + `TeamMember`. (Today's Add Roster Player.)
2. `playerEmail`, no account match → managed `User` (with email) + `TeamMember` + `TeamInvitation`
   + invite email. **New:** roster entry exists immediately.
3. `playerEmail` matches an existing account → **no** `TeamMember`; `TeamInvitation` + email only.
   Response flags this (`rostered: false, invited: true`) so the UI can explain.
4. `guardianEmail` present (any of the above) → `GuardianInvitation` for the child via
   `GuardianService` + guardian email. In case 3 the child id is the existing user's id.

Zod schema: new `addRosterPlayerSchema` (superRefine: `guardianRelationship` iff `guardianEmail`;
`playerEmail`/`guardianEmail` must differ). Old endpoints stay mounted and functional during the
transition for old mobile clients, marked deprecated in code comments; remove after the OTA is
verified adopted.

### Invitation lifecycle

- **Resend:** `POST /api/v1/invitations/:id/resend` (gate: `canManageRoster` on the invitation's
  team; write rate limit). Only PENDING (incl. lazily-expired → flip to EXPIRED and create a fresh
  row, reusing the `createInvitation` stale-row pattern) — rotate token + `expiresAt` (D4). Response
  goes through the `INVITATION_*_SELECT` constants + `omitToken`; **tests must assert token absence**
  (audit #14 discipline).
- **Cancel:** existing `DELETE /api/v1/invitations/:id`; semantics per D1 (roster entry untouched).
- **Accept (token + authenticated):** replace the `TeamMember` insert with create-if-missing inside
  the existing `transitionPending()` transaction; jersey/position from the invitation apply only on
  create. Race-safety (partial unique index, 400 for the loser) unchanged.
- **Reject:** transition only; roster entry untouched (D1).
- Guardian invitations: same resend treatment via
  `POST /teams/:teamId/members/:playerId/guardians/:invitationId/resend` (should-have; if it slips,
  the existing re-invite-after-expiry path remains and v1 ships player-invite resend only).

### Roster payload

- `GET /teams/:id` `members[]` gains `invitationStatus: 'none' | 'pending' | 'expired' | 'accepted'`
  + `invitationId` (for resend/cancel), derived from the latest `TeamInvitation` per (team, player).
  Extend the named `TEAM_INCLUDE`/select constants and exported Prisma payload types — no inline
  includes, and the joined invitation must select **without** `token`.
- `GET /teams/:id` additionally returns `pendingInvitations[]`: PENDING invites for
  **existing-account** users not yet on the roster (case 3), `{ invitationId, playerId, name,
  email?, expiresAt }`, email per the `canManageRoster` visibility rule.
- Email-visibility rules (role matrix B2.5) apply unchanged to both.

### Ripple effects to verify (tests, not hope)

- `NotificationService.sendToTeam` now includes never-signed-in members (harmless — no push tokens)
  and guardians of such members (intended).
- Player directory scoping ("shares a team with caller") now matches unaccepted members — confirm
  this is acceptable (they are real roster-mates; yes).
- Stats: members with no events already render EmptyState (existing 404 path) — no change.
- Usage metering counts staff, not members — untouched.
- Game tracker: unaccepted players are `TeamMember`s and therefore trackable — this is the point.

## Mobile changes

- **`app/teams/[id]/players.tsx` rewrite:** single Add Player form (name, player email, parent
  email + relationship chips, jersey, position, photo). Roster list shows every member with a
  status chip: **Active** (accepted/claimed), **Invited** (pending), **Invite expired**,
  **Not invited** (managed, or cancelled/rejected per D1); existing-account pending invites render
  as "Invited" rows. Per-row actions (gated `canManageRoster`): Resend, Cancel invite, Invite
  (for not-invited players with an email — creates a fresh invitation), Remove player (existing).
- Wire the currently-unused `useTeamInvitations` / `useCancelInvitation`; add
  `useResendInvitation`, `useAddRosterPlayer`. Invalidations: team detail/lists +
  `invitationKeys`; expiry copy via `utils/invitation-expiry.ts`.
- Audit every `team.members` consumer: team detail header/count, game detail roster, RSVP picker,
  tracker player list, stats screens.
- Guardian entry point from the add form coexists with the existing per-player guardians screen
  (`…/players/[playerId]/guardians.tsx`), which remains the management surface.
- i18n strings for all new copy.

## Email / web

- Invite email copy: "You've been added to <team>" framing (the roster entry now exists);
  guardian template unchanged. Both templates via the existing `Mailer` abstraction.
- `web/app/invite/[token]`: copy shift only ("activate your access / confirm you're joining");
  polymorphic `kind` handling unchanged.
- **SES production access (#23) is blocking-adjacent:** a visible Resend button that silently
  fails is worse than none. Either land #23 first, or surface mailer failures to the coach
  (minimum: the create/resend response includes `emailSent: boolean` and the UI toasts a warning —
  do this regardless; the send is best-effort post-commit today and invisible).

## Tests

- **Backend API + service:** all four create cases; accept with pre-existing membership; cancel /
  reject leaving the roster entry; resend (rotation, expiry refresh, rate limit, **token absent
  from every response**); guardian-invite-at-creation; schema tests for `addRosterPlayerSchema`
  edge cases (email-less, both emails equal, relationship without email, jersey 0).
- **Mobile Jest:** form branching, chip derivation, action gating (`canManageRoster` vs player view).
- **Maestro:** update `roster-management.yaml`; new flow: add without email → player visible
  immediately; add with email → "Invited" chip. (Required for major mobile functionality.)
- **E2E plan:** rewrite the roster/invitation sections of `docs/testing/e2e-test-plan-v2.0.md`
  scripted around the old two-button flow.
- **Seed (`backend/prisma/seed.ts`):** keep Maestro fixtures valid (Frank Vogel, Steph Curry,
  Sonya/Dell Curry, Warriors/Lakers); add a fixture in each invite state for chip testing.

## Docs (same-change requirement)

- **CLAUDE.md:** rewrite "Team Invitations", the mobile roster/players sections, and the guardian
  link-flow paragraph to the new semantics — in the same PRs as the code.
- This spec: flip Status to Accepted after review; append deviations during implementation.
- Post-ship: `/document-release` pass; status comments on any issues touched (no premature
  "Closes #N").

## Rollout (simplified by D5 — data is disposable)

1. **Backend PR** (endpoint + lifecycle + payload + tests + CLAUDE.md). Old mobile clients keep
   working against the deprecated endpoints. Deploy to ECS.
2. **DB reset:** no backfill. Wipe app data (truncate user/team/game tables or
   `prisma migrate reset` + `npx prisma db seed` equivalent against prod) — the 8 Spartans
   pending invitations vanish with everything else; re-adding them through the new flow is the
   acceptance test. (Reset procedure per the RDS runbook's access pattern; coordinate with no one —
   test data only.)
3. **Mobile PR** (form + chips + actions + Jest + Maestro + e2e plan). JS-only → **OTA** to the
   production branch (runtime 1.2.0, builds #25+); verify manifest per the OTA checklist. Confirm
   no native dep sneaks in (validate-in-binary rule) — none is expected.
4. **Verify:** recreate Spartans 5/6 via the new flow — players visible immediately with chips,
   emails delivered (verified SES aliases), resend works, guardian invite works.
5. Remove deprecated endpoints in a follow-up once OTA adoption is confirmed.

## Out of scope (recorded so nobody re-litigates)

- Auto-accept for existing accounts (D2 — deferred, needs consent/enumeration review).
- Bulk import / CSV roster upload; non-player roster members; roster ordering.
- Claim-by-code, parent-to-parent invites (guardian spec v1 exclusions stand).
- Per-invite email delivery tracking beyond `emailSent` (bounce webhooks etc. — future).
