# PARENT role — spec (approved 2026-08-23)

Source: role × capability audit (decision 1 = build). Status: **approved 2026-08-23**; implementation in progress.

## Problem

`UserRole.PARENT` exists and `Guardian { parentId, childId, relationship, isPrimary }` is in the schema, but
nothing assigns the role or references the model. Managed (COPPA) players — kids without an email, created by
a coach via `POST /teams/:id/managed-players` — have no adult who can see their schedule, RSVP for them, or get
the team's announcements.

## Goal

A parent/guardian has an account of their own, is linked to one or more child players, and can **see and
respond on behalf of** those children — never manage a team.

## Roles & linking

- A user becomes `PARENT` when their first `Guardian` link is created (role is derived; not self-selectable in
  "Change account type"). A parent who also coaches keeps `COACH` — `Guardian` links are independent of role;
  the UI shows "Parent" affordances whenever `guardianOf.length > 0`. (Simplest: global role stays whatever it
  is; `PARENT` is what we set for a brand-new account created through a guardian invite.)
- **Link paths**
  1. **Coach invites a guardian** from a managed player's roster card: `POST /teams/:id/members/:playerId/guardians
     { email, relationship }` → creates (or reuses) the adult's `User` row (unverified email, same rules as
     `POST /players`), a `PENDING` `GuardianInvitation` token emailed via the mailer (reuse the invitation
     template family), accepted through `capyhoops.com/invite/<token>` like team invites. Acceptance creates the
     `Guardian` row. Requires `canManageRoster`.
  2. **Parent claims a child by code** (later; not in v1).
- A child can have several guardians; exactly one `isPrimary` (first link). Removing the last guardian does
  not delete the child.

## What a guardian can do (per linked child)

| Capability | Guardian | Note |
|---|---|---|
| See child's teams, schedule, live games, box scores, season stats | ✅ | same read set as a roster member — implemented by extending `canAccessTeam` with "guardian of a member" |
| RSVP to a game for the child | ✅ | new `playerId` param on `POST /games/:id/rsvp`, allowed when caller is guardian of that player |
| Receive team announcements / push for child's teams | ✅ | `sendToTeam` audience += guardians of members |
| Accept / reject a team invitation addressed to the child | ✅ | `acceptInvitation` allows guardian of `invitation.playerId` |
| Edit child's name / avatar / jersey | ✅ (name, avatar) | via existing managed-player update rules; jersey stays coach-only |
| See other members' emails | ❌ | |
| Track stats, create games, manage roster, post announcements | ❌ | |
| Be added as team staff | ✅ | independent — a parent can also be Team Manager |

## API changes

- `GET /auth/me` → add `guardianOf: { childId, childName, relationship, isPrimary }[]`.
- `POST /teams/:teamId/members/:playerId/guardians`, `GET …/guardians`, `DELETE …/guardians/:guardianUserId`
  (coach `canManageRoster`, or the guardian removing themself).
- `GET /invitations/by-token/:token` returns `kind: 'team' | 'guardian'`; accept path branches.
- `POST /games/:id/rsvp { status, playerId? }`.
- `utils/permissions.ts`: `canAccessTeam` gains the guardian branch; `getTeamPermissions` returns `canViewStats`
  only for guardians (finally a consumer for that flag).

## Mobile

- New "My kids" section on Profile (list of children, each → child's stats/teams); Home shows the next game
  across own + children's teams; game detail RSVP control gets a "for <child>" picker when the user is a guardian
  of a member; Invitations tab shows guardian invites with "Accept for <child>".
- "Change account type" hidden when `guardianOf.length > 0` (same as today for PARENT).
- Roster card (coach view) for a managed player: "Invite a parent" action.

## Out of scope (v1)

Claim-by-code, parent-to-parent invites, child accounts converting to full accounts (already handled by
`syncUser`'s managed-player claim), payments.

## Tests

API tests for every new route incl. negative cases (non-guardian RSVPs for a child → 403; guardian tries to
record an event → 403); `permissions.test.ts` guardian branches; mobile hook/screen tests; Maestro
`guardian-rsvp.yaml` (seed a guardian for a managed player).

## Sequencing

After the staff-management and mobile-gating PRs land (they touch `permissions.ts`, team detail and game detail).
Estimate: 1 backend PR (schema is already there — just a `GuardianInvitation` model + routes), 1 mobile PR, 1 OTA.
