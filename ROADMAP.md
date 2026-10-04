# Roadmap

Strategy document for Hooplings (formerly Capy Hoops / Basketball Tracker). Narrative lives here;
execution lives in GitHub Issues and Milestones. Each phase below maps to a
milestone; each checklist item maps to an issue.

## Positioning

A hybrid of GameChanger (live stat tracking, box scores) and a lightweight
team-management app (teams, games, RSVPs, announcements). The app tracks live games *and* manages
the team around them — most competitors do one or the other well.

**Differentiators**
- Live in-game stat tracking with a spectator-friendly real-time view
- Box scores + season stats built in, not a bolt-on
- COPPA-compliant managed players for youth leagues

**Non-goals (for now)**
- Full video/clip platform (GameChanger territory)
- Full league-ops / registration platform (incumbent team-management suites) — see v2.2
- Multi-sport expansion

## Phases

### v2.0 — General Access (GA)

First public release. Open signups to anyone, not just early-access teams.

The core product — game tracking, rosters, stats, guardians, live spectating —
is built and manually validated. What gates GA is the ring around it: the paths
a person who is *not* the founder has to walk. Signup, invitation, legal,
and operations.

Milestone: [`v2.0 GA`](../../milestone/1)

**Launch gate.** A person we have never met installs from TestFlight, signs up,
creates a team, invites a parent, and that parent accepts from an email — with
no admin intervention at any step. Until that runs clean, the cohort does not
widen. Two of those steps are still blocked: SES is sandboxed, so no email
reaches an unverified address (#23), and the parent's accept-from-email link has
nowhere to land until `web/` is deployed (#30).

The blocker set was rebuilt on 2026-08-30 by checking every open issue against
the running code, live DNS, and the production AWS account rather than against
its own description. Full assessment, including the deferral rationale for
everything *not* on this milestone:
[GA readiness assessment](https://claude.ai/code/artifact/d2153c41-97ca-4e54-ad17-9acbe394848f)
(a dated snapshot — the milestone is the live source of truth).

What is still open is listed only on the milestone, never here: a copy of the
open list in this file is what went stale between the rebuild and 2026-10-04,
when the "paths a stranger walks" and "infrastructure" lanes of that rebuild had
closed in full (they are under "Shipped so far"). The lanes that remain are the
external clocks that queue behind AWS, Apple, counsel and the identity provider,
and the `web/` deploy that gives the invite email somewhere to land.

Ordering is not free. The chain now starts at `#30 → #23 → #24`: each link makes
the next safe, and skipping ahead produces user-visible breakage rather than
just delay. Leaving SES sandbox before #30 ships, for instance, means working
email carrying a dead link — worse than no email.

Shipped so far (closing dates are GitHub's, in UTC):
- Self-serve team creation (#442, closed 2026-08-31): a new coach creates a
  team without an admin.
- League and season list scoping (#443, closed 2026-08-31): list and detail
  endpoints are caller-scoped; an unaffiliated caller gets 404.
- Account deletion (#444, closed 2026-09-08): self-serve `DELETE /auth/me`,
  guardian deletion of a managed child's record, operator script and runbook
  (`docs/runbooks/data-subject-requests.md`).
- FREE-tier team cap lifted (#445, closed 2026-09-27): no dead-end paywall
  until a purchase flow exists; see "Tier design" below.
- Autoscaling pinned to one task (#446, closed 2026-09-27): `max_capacity`
  validated to 1, `MAX_REPLICAS=1`, startup guard.
- Apex CORS (#447, closed 2026-09-06) and the task-definition split-brain
  (#53, closed 2026-08-30; `infra/task-definition.json` is the only source of
  truth), the two links that used to head the ordering chain.
- Production alerting (#448, closed 2026-09-29): fifteen CloudWatch alarms
  emailing an SNS subscription, applied and verified live
  (`docs/runbooks/on-call.md`).
- SES bounce and complaint handling (#449, closed 2026-09-29): event
  publishing, suppression flags on the roster and reputation alarms.
- Socket.io handlers for live game event broadcast (#26) — backend rooms,
  snapshot on join, `game-event` + `game-status-change` broadcasts.
  Single-replica only; see follow-ups #48 (public spectator mode), #49
  (mid-session JWT reauth) and #452 (Redis adapter — the multi-replica
  prerequisite, which #26 was closed without doing).
- Sentry error tracking for backend + mobile (#28), with PII scrubbing and
  release-tagged events. This is error capture; alerting that notifies a human
  arrived separately with #448 above.

### v2.1 — Parity

Reach feature parity with the incumbent team-management apps so we don't
lose deals on "does it have an iCal feed?" or "can I export stats?"

Focus: calendar sync, recurring events, photo gallery, stats export, SMS.

Milestone: [`v2.1 Parity`](../../milestone/2)

Shipped so far:
- iCal feed per team (#32) — `GET /teams/:id/calendar.ics?token=...` with
  token-auth, rate-limited, revocable.
- Stats export endpoints (#36) — streaming CSV (game events, season stats)
  and PDF box score, with RFC 5987 filenames and CSV-injection escaping.
  #50 was closed on 2026-10-03 with a per-user export rate limit (20/min,
  PR #636) instead of a worker thread; a worker thread is reconsidered only if
  a client surfaces export and concurrent volume is observed.

### v2.2 — Monetization

Turn on revenue. Stripe subscriptions first (Coach Premium, League), then
Stripe Connect for registration/dues payments (take-rate revenue is where
the incumbent team-management apps make their money).

Milestone: [`v2.2 Monetization`](../../milestone/3)

## Tier design (target)

This table is the *target* design, not what the code enforces. **What the code
enforces today:** teams and seasons are unlimited on every tier, FREE included
(`USAGE_LIMITS` in `backend/src/services/entitlements/index.ts`). The FREE team
limit of 3 was lifted in #445 because enforcement had shipped without a purchase
path, leaving a dead-end paywall in front of a product that sells nothing. The
PREMIUM feature gates (stats export, calendar sync) are still enforced by the
API. Until a purchase flow exists (#41) the only way onto a paid tier is a
system ADMIN comping the account (`PATCH /api/v1/admin/users/:userId/subscription`,
see `docs/architecture/entitlements-and-usage.md`). Re-introduce a cap only alongside a real upgrade flow, and
change the number in `USAGE_LIMITS` only — never inline.

| Tier | Price | Audience | Key features |
|---|---|---|---|
| Free | $0 | Independent coaches, tryouts | Unlimited teams (no cap today; any future cap ships with the upgrade flow), full stat tracking, basic schedule, push notifications |
| Coach Premium | ~$9.99/mo or ~$79/yr | Serious coaches, club teams | Unlimited teams, email/SMS, calendar sync, stats export, photo gallery, ad-free |
| League | ~$49–99/mo | Multi-team orgs | Everything above + org messaging, tournament brackets, admin dashboards |
| Registration payments | 2.9% + $0.30 take-rate | Leagues collecting dues | Stripe Connect; highest-ARPU feature |

iOS subscriptions must use Apple IAP (15–30% Apple tax). Web-only upgrade is a
legitimate workaround under the Epic v. Apple ruling and is worth evaluating.

## Agent execution

Many issues are labelled `agent-ready` — they are scoped, have acceptance
criteria, file paths, and verification commands, and are safe to hand to an
unassisted background agent. Issues labelled `needs-human` require credentials,
design judgment, or product scoping and should not be delegated.

## Version scheme

- Milestone numbers map to git tags. Shipping everything in `v2.0 GA` triggers
  a `v2.0.0` tag and a GitHub Release.
- Minor versions (v2.0.1, v2.0.2…) are patch releases within a phase.
- Major bumps (v2 → v3) are reserved for architectural changes or second public
  launch moments.
