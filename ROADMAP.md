# Roadmap

Strategy document for Capy Hoops / Basketball Tracker. Narrative lives here;
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

Focus: close the gaps that block a parent or coach from relying on the app
day-to-day (email notifications, live spectator view, observability, legal).

Milestone: [`v2.0 GA`](../../milestone/1)

### v2.1 — Parity

Reach feature parity with TeamSnap on the team-management surface so we don't
lose deals on "does it have an iCal feed?" or "can I export stats?"

Focus: calendar sync, recurring events, photo gallery, stats export, SMS.

Milestone: [`v2.1 Parity`](../../milestone/2)

### v2.2 — Monetization

Turn on revenue. Stripe subscriptions first (Coach Premium, League), then
Stripe Connect for registration/dues payments (take-rate revenue is where
TeamSnap makes its money).

Milestone: [`v2.2 Monetization`](../../milestone/3)

## Tier design (target)

| Tier | Price | Audience | Key features |
|---|---|---|---|
| Free | $0 | Independent coaches, tryouts | 1 team, full stat tracking, basic schedule, push notifications |
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
