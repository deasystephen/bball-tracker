# Roadmap

Strategy document for Hooplings (formerly Capy Hoops / Basketball Tracker). Narrative lives here;
execution lives in GitHub Issues and Milestones. Each phase below maps to a
milestone; each checklist item maps to an issue.

## Positioning

A hybrid of GameChanger (live stat tracking, box scores) and TeamSnap-lite
(teams, games, RSVPs, announcements). The app tracks live games *and* manages
the team around them — most competitors do one or the other well.

**Differentiators**
- Live in-game stat tracking with a spectator-friendly real-time view
- Box scores + season stats built in, not a bolt-on
- COPPA-compliant managed players for youth leagues

**Non-goals (for now)**
- Full video/clip platform (GameChanger territory)
- Full league-ops / registration platform (TeamSnap Pro territory) — see v2.2
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
widen. Two of those steps are broken today (#442, #30).

The blocker set was rebuilt on 2026-08-30 by checking every open issue against
the running code, live DNS, and the production AWS account rather than against
its own description. Full assessment, including the deferral rationale for
everything *not* on this milestone:
[GA readiness assessment](https://claude.ai/code/artifact/d2153c41-97ca-4e54-ad17-9acbe394848f)
(a dated snapshot — the milestone is the live source of truth).

Blockers group into four lanes, three of which run in parallel:

- **External clocks — start first, they queue.** SES production access (#23),
  privacy policy + ToS with a COPPA read (#25), WorkOS production environment
  (#24), support inbox (#450), App Store Connect metadata (#451).
- **The paths a stranger walks.** Self-serve team creation (#442), league and
  season list scoping (#443), account deletion (#444), the dead-end free-tier
  team cap (#445).
- **Infrastructure.** Pin autoscaling to one task (#446), apex CORS (#447),
  production alerting (#448), SES bounce handling (#449), task-definition
  split-brain (#53).
- **The deploy that unblocks onboarding.** `web/` to capyhoops.com (#30) —
  carries the legal pages, the invite funnel, and Universal Links.

Ordering is not free. `#53 → #447 → #30 → #23 → #24` is a genuine chain: each
link makes the next safe, and skipping ahead produces user-visible breakage
rather than just delay. Leaving SES sandbox before #30 ships, for instance,
means working email carrying a dead link — worse than no email.

Shipped so far:
- Socket.io handlers for live game event broadcast (#26) — backend rooms,
  snapshot on join, `game-event` + `game-status-change` broadcasts.
  Single-replica only; see follow-ups #48 (public spectator mode), #49
  (mid-session JWT reauth) and #452 (Redis adapter — the multi-replica
  prerequisite, which #26 was closed without doing).
- Sentry error tracking for backend + mobile (#28), with PII scrubbing and
  release-tagged events. Note this is error capture, not alerting: nothing
  currently notifies a human (#448).

### v2.1 — Parity

Reach feature parity with TeamSnap on the team-management surface so we don't
lose deals on "does it have an iCal feed?" or "can I export stats?"

Focus: calendar sync, recurring events, photo gallery, stats export, SMS.

Milestone: [`v2.1 Parity`](../../milestone/2)

Shipped so far:
- iCal feed per team (#32) — `GET /teams/:id/calendar.ics?token=...` with
  token-auth, rate-limited, revocable.
- Stats export endpoints (#36) — streaming CSV (game events, season stats)
  and PDF box score, with RFC 5987 filenames and CSV-injection escaping.
  See follow-up #50 (move PDF off the event loop).

### v2.2 — Monetization

Turn on revenue. Stripe subscriptions first (Coach Premium, League), then
Stripe Connect for registration/dues payments (take-rate revenue is where
TeamSnap makes its money).

Milestone: [`v2.2 Monetization`](../../milestone/3)

## Tier design (target)

This table is the *target* design, not what the code enforces. At GA the app is
free and uncapped: the FREE team limit is being lifted in #445 because
enforcement shipped without a purchase path, leaving a dead-end paywall in front
of a product that sells nothing. Re-introduce a cap only alongside a real
upgrade flow (#41), and change the number in `USAGE_LIMITS` only — never inline.

| Tier | Price | Audience | Key features |
|---|---|---|---|
| Free | $0 | Independent coaches, tryouts | Full stat tracking, basic schedule, push notifications (team cap deferred — see #445) |
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
