# Roster / Invite Unification Spec (TeamSnap-style Add Player)

**Status:** Shipped 2026-08-28 — backend in PR #416 (deployed, ECS :252), mobile in PR #417 (production OTA group `27d9d5d9`, runtime 1.2.0); on-device acceptance passed (Spartans 5/6 legacy invitations render as Invited rows). Decisions locked 2026-08-27; eng review (incl. outside voice) complete, all findings folded
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
   an invitation goes out whenever an email is present. Managed-vs-invited becomes an outcome,
   not an upfront decision.
2. **Every added player appears on the roster immediately**, with an inline invite-status chip.
3. **Coaches can see, resend, and cancel invitations** from the roster screen.
4. **Youth pattern:** a coach can enter a parent's email at creation; the parent gets a guardian
   invitation (existing guardian system) in the same step.

## Locked product decisions (2026-08-27)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Cancel/reject vs roster entry | **Player stays on roster** as an uninvited managed player. **Amended (review T1, narrowed at ship review):** only the invitee's explicit **REJECTED** transition nulls the managed row's `email` (guarded: `workosUserId` null, no other PENDING/ACCEPTED invitation), because `syncUser` links any unclaimed row by email on first login. **Cancel and expiry deliberately keep the email**: a coach's cancel must not destroy coach/admin-entered addresses (re-inviting would create a duplicate account — red-team RT5), and resend-after-expiry needs the address; the invite email already informed that mailbox. Invites to an **existing account** never create a roster entry pre-accept, so reject there just removes the "Invited" row. |
| D2 | Auto-accept for existing accounts | **Deferred.** Explicit accept stays in v1. |
| D3 | Parent email at creation | **In v1**, for players who get a roster entry at creation (cases 1–2 below). For an existing-account player (case 3) the guardian system's member requirement (`guardian-service.ts` `requireMember`) makes this impossible pre-accept; the API returns `guardianInvited: false` + reason and the UI hints "add the parent after they accept" (review issue 1A). |
| D4 | Resend mechanics | ~~In-place token rotation~~ **Amended (review 3A + T5):** resend = supersede — transition the old PENDING row to EXPIRED and create a fresh invitation through the existing create path, in one transaction. Old link dies (original D4 intent), one write path for invitation birth. No dedicated resend endpoint: `POST /teams/:id/invitations` gains `supersede: true` (expire current PENDING + recreate); "Invite" and "Resend" are the same client call. |
| D5 | Existing data | Disposable in principle, but **no reset is needed or performed** (review T4): legacy pending invitations render correctly under the new model (Invited rows via the invitations endpoint; accept creates the membership). Rollout is pure code. |

## Consent model (the invariant everything hangs off)

- **Case 1 — no email:** managed `User` + `TeamMember` in one `$transaction` (today's
  `addManagedPlayer`).
- **Case 2 — email with no claimed account:** managed `User` **with `isManaged: true` +
  `managedById: <coach>`** + `TeamMember` + `TeamInvitation` + invite email, one transaction.
  Setting the managed flags is deliberate and is an authz statement (review T2): per B2.10 the
  managing coach can edit/delete the player until first sign-in — wanted, so typos are fixable
  pre-claim. The deprecated create-and-invite arm of `POST /teams/:id/invitations` starts setting
  the same flags (server-side change, invisible to old clients; today it sets neither —
  `invitation-service.ts:241-249`).
  - **Middle-case rule (review T3):** an email matching an **unclaimed** row (`workosUserId`
    null — provisioned by another team's invite, `POST /players`, or a guardian invite) is
    case 2: reuse the row, add `TeamMember` + invitation, set `managedById` only if null,
    never touch `name`/`role`. Find-or-create wraps the unique-email race with
    P2002-catch-and-reuse inside the transaction (the existing create-and-invite arm shares
    this latent 500 — fix both).
- **Case 3 — email matches a claimed account (`workosUserId` set), or invite-by-playerId:**
  invitation **only** — no `TeamMember` until accept (membership would be de facto auto-accept,
  deferred by D2). Response flags `rostered: false, invited: true` so the UI explains.
  *Documented residual risk (review T6.2):* this response tells a roster-managing coach whether
  an email has a claimed account — accepted as a coach-scoped, rate-limited signal; revisit
  together with D2.
- **Claim path:** `syncUser` links a pre-provisioned row by email on first WorkOS login and
  clears `isManaged`. Accepting the invitation is a notification-driven shortcut into that flow;
  accept must tolerate an already-existing membership (create-if-missing inside
  `transitionPending()`), since both accept paths currently insert `TeamMember` unconditionally
  (`invitation-service.ts:511,736`).

### Roster status chip (review T2, supersedes the first two derivation drafts)

Derived server-side per member from two signals, exposed on `GET /teams/:id` members:

```
isManaged = false  ─────────────────────────────► ACTIVE   (claimed via login)
isManaged = true ─┬─ latest invitation ACCEPTED ► ACTIVE   (accepted via link, never logged in)
                  ├─ PENDING, expiresAt future  ► INVITED
                  ├─ PENDING, expiresAt past    ► INVITE EXPIRED (client computes from expiresAt)
                  └─ otherwise                  ► NOT INVITED (incl. lazily-flipped EXPIRED,
                                                  REJECTED, CANCELLED rows)
```

- The team payload joins invitations with `status IN (PENDING, ACCEPTED)` only — `id`, `status`,
  `expiresAt`, **no token** (audit #14 class; tests assert absence). Single include, no N+1.
- **Resend targets only PENDING rows** (review T6.3). "Invite expired"/"Not invited" rows offer
  a fresh **Invite** action instead — same `supersede` create call — so a lazily-flipped row never
  400s on a stale invitation id.
- Existing-account pending invites (case 3) are **not** in the team payload: the roster screen
  merges them client-side from `GET /invitations?teamId=` (already built and permission-scoped),
  excluding any `playerId` already present in `members[]` (dedupe, review T6.6).
- Mobile derivation lives in `utils/roster-status.ts` (project rule: derive via utils, never
  inline — same pattern as `game-result.ts`), unit-tested across all chip states.

## Backend changes

### New unified endpoint

`POST /api/v1/teams/:teamId/players` (gate: `canManageRoster`; supersedes both
`POST /teams/:id/managed-players` and the `{name,email}` arm of `POST /teams/:id/invitations`).
**Prerequisite (review T6.1):** delete the 410 tombstone already registered on this exact path
(`api/teams/routes.ts:215`) — left in place it shadows the new route and every call dead-ends.

```
{
  name: string,                       // required
  playerEmail?: string,               // optional; find-or-create per the middle-case rule
  guardianEmail?: string,             // optional; requires relationship; honoured cases 1-2 only
  guardianRelationship?: GuardianRelationship,
  jerseyNumber?: number,              // 0 is valid — null-check, never truthiness
  position?: string,
  profilePictureUrl?: string
}
```

Response: `{ member | invitation, rostered: boolean, invited: boolean, guardianInvited: boolean,
emails: { player?: boolean, guardian?: boolean } }` — per-send flags (review T6.4) because case 4
sends two independent best-effort emails; the UI warns specifically about whichever failed.

Zod: `addRosterPlayerSchema` (superRefine: `guardianRelationship` iff `guardianEmail`;
`playerEmail !== guardianEmail`). Old endpoints stay mounted and functional during the transition
(the deprecated create-and-invite arm additionally adopts the case-2 managed flags), removal is a
follow-up after OTA adoption.

### Invitation lifecycle

- **Supersede/resend (D4 as amended):** `POST /teams/:id/invitations { playerId, supersede: true }`
  expires the current PENDING row and creates a fresh one via the existing create machinery, one
  transaction; response through the token-free selects + `omitToken`.
- **Cancel:** existing `DELETE /api/v1/invitations/:id`. **Reject:** existing flow. Both transition
  via `transitionPending()` and (new, T1) null the managed row's `email` when `workosUserId` is
  null; roster entry untouched (D1).
- **Accept (token + authenticated):** membership becomes create-if-missing inside the existing
  transaction; jersey/position from the invitation apply only on create. Race rules unchanged.
- Guardian-invite resend uses the same supersede pattern on its own create path (should-have; the
  expiry-re-invite fallback stands if it slips).

### Ripple effects to verify (tests, not hope)

- `sendToTeam` now reaches guardians of never-signed-in members (intended); push no-ops for them.
- Player directory scoping now matches unaccepted members (acceptable — real roster-mates).
- Stats/EmptyState, usage metering (staff-based), tracker eligibility: as analyzed, no change
  needed; tracker treating unaccepted members as trackable is the point.

## Mobile changes

- **`app/teams/[id]/players.tsx` rewrite:** single Add Player form (name, player email, parent
  email + relationship chips, jersey, position, photo). Roster list: every member with its chip
  (Active / Invited / Invite expired / Not invited) + case-3 "Invited" rows merged from
  `useTeamInvitations` (deduped). Row actions gated on `canManageRoster`: Resend (PENDING only),
  Invite (fresh supersede call), Cancel invite, Remove player (existing). Case-3 add shows the
  "not on roster until they accept" explanation; `guardianInvited: false` shows the
  "add the parent after they accept" hint; `emails.player/guardian === false` toasts a specific
  send-failure warning.
- Hooks: wire `useTeamInvitations` / `useCancelInvitation`; add `useAddRosterPlayer`,
  supersede-aware `useCreateInvitation`. Invalidations: team detail/lists + `invitationKeys`.
- Audit every `team.members` consumer: team detail header/count, game detail roster, RSVP picker,
  tracker player list, stats screens.
- i18n strings for all new copy.

## Email / web

- Invite email copy branches (review T6.5): cases 1–2 "You've been added to <team> — activate
  your access"; case 3 "You've been invited to join <team>". Guardian template unchanged.
- `web/app/invite/[token]`: copy shift only; polymorphic `kind` handling unchanged.
- **SES production access (#23) is blocking-adjacent** for the Resend button; the per-send
  `emails` flags surface failures regardless.

## Tests

Full matrix (spec review adopted all gaps, issue 4A):

- **Backend API + service:** cases 1/2/3 + middle-case reuse + P2002 race retry; case 3 +
  `guardianEmail` → `guardianInvited: false`; 403 for non-roster-managers; per-send `emails`
  flags on SES failure; accept create-if-missing (**CRITICAL regression guard**) + concurrent
  accept loser 400 + accept after coach removed the member; supersede (old EXPIRED, new PENDING,
  email, rate limit) + supersede-vs-accept race; reject/cancel email-strip (and no-strip once
  claimed) with roster entry intact; **token absent from the team-payload invitation join and
  every new response**; schema edges (jersey 0, equal emails, relationship w/o email).
- **Mobile Jest:** `utils/roster-status.ts` all chip states; form branching; action gating;
  double-tap Add creates one player; send-failure toast; case-3 Invited row rendering + dedupe.
- **Maestro:** update `roster-management.yaml`; new flow (add without email → visible at once;
  add with email → Invited chip). Required for major mobile functionality.
- **E2E plan:** rewrite the roster/invitation sections of `docs/testing/e2e-test-plan-v2.0.md`.
- **Seed:** keep Maestro fixtures valid; add one fixture per chip state.

## Failure modes (review)

| Path | Failure | Covered by |
|------|---------|-----------|
| Unified create | SES send fails silently | `emails` flags + toast + test |
| Unified create | Unique-email race → 500 | P2002 catch-and-reuse + test |
| Accept | Membership already exists → P2002 500 | create-if-missing + CRITICAL test |
| Supersede | Races accept → wrong winner | `transitionPending` 400 + test |
| Reject → later signup | Silent auto-membership | T1 email strip + test |
| Chip render | Stale/lying states | T2 derivation + helper unit tests |
| Team payload | Token leak via new join | select constants + absence tests |

No silent critical gaps remain: every failure path above has error handling, a test, and a
user-visible outcome.

## What already exists (reuse map)

- `TeamService.addManagedPlayer` — case 1 verbatim; transaction pattern for all cases.
- `InvitationService.createInvitation` — email find-or-create, stale-PENDING flip, token
  hygiene; gains the supersede option and managed flags.
- `transitionPending()` — every lifecycle change, including the new email-strip.
- `GuardianService.inviteGuardian` — guardian-at-creation, called for cases 1–2 only.
- `syncUser` claim-by-email — the account-linking half of "Active"; untouched.
- `GET /invitations?teamId=` + unused mobile hooks (`useTeamInvitations`,
  `useCancelInvitation`) — case-3 rows and cancel, no new API surface.
- Rebuilt rather than reused: nothing. The 410 tombstone on the target path is deleted.

## NOT in scope (considered and deferred, with rationale)

- **Auto-accept for existing accounts** (D2) — consent/enumeration review pending; revisit with
  WorkOS production cutover.
- **Bulk import / CSV roster upload** — separate feature, no interaction with these semantics.
- **Non-player roster members, roster ordering** — TeamSnap parity items with no current user.
- **Claim-by-code, parent-to-parent invites** — guardian spec v1 exclusions stand.
- **Email delivery tracking beyond per-send flags** (bounce webhooks) — needs SES prod access
  first (#23).
- **Invite-funnel analytics** — captured in TODOS.md (review decision), post-ship.
- **Deprecated endpoint removal** — follow-up PR after OTA adoption is confirmed.

## Rollout (no data surgery — T4)

1. **Backend PR:** tombstone deletion, unified endpoint, lifecycle amendments (T1/T2/T3/T5),
   payload join, tests, CLAUDE.md rewrite of the affected sections. Deploy to ECS.
2. **Verify against live legacy data:** Spartans 5/6's existing pending invitations must render
   as Invited rows and accept into memberships — this is the acceptance test; no reset.
3. **Mobile PR:** form + chips + actions + Jest + Maestro + e2e plan + i18n. JS-only → **OTA**
   (runtime 1.2.0, builds #25+); verify manifest per the OTA checklist; confirm no native dep.
4. **Post-ship:** `/document-release` pass; status comments on touched issues; deprecated-endpoint
   removal follow-up.

## Parallelization

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| Backend: endpoint + lifecycle + payload | backend/src/api, backend/src/services, backend/tests | — |
| Backend: CLAUDE.md + e2e plan docs | CLAUDE.md, docs/testing | endpoint semantics settled (same PR) |
| Mobile: screen + hooks + utils + tests | mobile/app, mobile/hooks, mobile/utils, mobile/__tests__ | backend response shapes |
| Maestro + seed fixtures | .maestro, backend/prisma | both PRs' behavior |

Lane A: backend (sequential, one PR). Lane B: mobile (starts once Lane A's response shapes are
fixed — can develop against the spec in parallel, integration-test after Lane A deploys). Docs
ride inside their lane's PR. Effectively sequential PRs with overlapping development; no worktree
fan-out needed.

## Implementation Tasks

Synthesized from review findings. Checkbox as you ship.

- [ ] **T1 (P1, CC: ~20min)** — backend — Strip managed row email on reject/cancel while unclaimed
  - Surfaced by: outside voice #1 (consent hole via syncUser claim path)
  - Files: backend/src/services/invitation-service.ts, tests/services+api
  - Verify: reject → signup with that email → NOT a member; test asserts
- [ ] **T2 (P1, CC: ~30min)** — backend — Case-2 managed flags (both arms) + PENDING+ACCEPTED chip join
  - Surfaced by: outside voice #2 (isManaged proxy lies ×3)
  - Files: invitation-service.ts, team-service.ts (include constants), tests
  - Verify: web-link accepter renders Active; legacy-arm row not Active while pending
- [ ] **T3 (P1, CC: ~2h)** — backend — Unified POST /teams/:id/players (4 cases, middle-case rule, P2002 retry, per-send email flags, guardian cases 1-2) + tombstone deletion
  - Surfaced by: spec core + outside voice #3/#4/#7 + review 1A
  - Files: api/teams/routes.ts, services, schemas, tests
  - Verify: full case-matrix API suite green
- [ ] **T4 (P1, CC: ~30min)** — backend — Accept create-if-missing (both paths) + races (CRITICAL regression guard)
  - Surfaced by: spec core, regression rule
  - Files: invitation-service.ts:511,736, tests
- [ ] **T5 (P2, CC: ~15min)** — backend — `supersede: true` on invitation create (resend)
  - Surfaced by: review 3A + outside voice #12
  - Files: invitation-service.ts, api/invitations, tests incl. supersede-vs-accept race
- [ ] **T6 (P2, CC: ~30min)** — backend — Token-absence tests for the new join + copy branches in mailer templates
  - Surfaced by: test review gap + outside voice #8
- [ ] **T7 (P1, CC: ~2h)** — mobile — players.tsx rewrite: form, chips (utils/roster-status.ts), actions, case-3 merge+dedupe, toasts
  - Surfaced by: spec core + outside voice #11 + T6.3 action rule
  - Files: mobile/app/teams/[id]/players.tsx, hooks, utils, __tests__
- [ ] **T8 (P2, CC: ~45min)** — mobile+e2e — Maestro flows, seed fixtures per chip state, e2e-plan rewrite
  - Surfaced by: test review
- [ ] **T9 (P2, CC: ~30min)** — docs — CLAUDE.md Team Invitations + roster sections rewrite (same PRs)
  - Surfaced by: docs-hygiene requirement

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 16 issues, 0 critical gaps open |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** Outside voice (Claude subagent, fresh context; Codex not installed) returned
  12 findings including 2 blockers at the plan's load-bearing joint (consent via the syncUser
  claim path; isManaged as a status proxy). All 12 verified against code and accepted with fixes
  (T1–T6 tensions); the in-session review's 4 findings (1A, 2A-as-revised, 3A-as-revised, 4A)
  are likewise folded. Zero findings rejected.
- **VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
