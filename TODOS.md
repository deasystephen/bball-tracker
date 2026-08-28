# TODOS

## Mobile / Analytics

### Invite-funnel analytics events

- **Priority:** P3
- **What:** Emit analytics events from the invitation lifecycle: `invite_sent`, `invite_resent`,
  `invite_accepted`, `invite_claimed_via_login`.
- **Why:** The roster/invite unification (docs/plans/roster-invite-unification-spec.md) redesigned
  the flow around invite visibility; funnel data is the only way to know whether coaches' invites
  actually convert. Without it, conversion problems surface as support anecdotes.
- **Pros:** Cheap to add at choke points the unification already touches; directly measures the
  redesign's outcome.
- **Cons:** Amplitude event taxonomy needs a naming pass; no user-facing value on day one.
- **Context:** Mobile has Amplitude wired (`services/` analytics); the backend has no analytics
  emission. Events would come from mobile actions (add/resend) and the accept screens (mobile +
  web invite page). `invite_claimed_via_login` needs a signal from the session flow (first login
  that linked a pre-provisioned row) — `GET /auth/callback` already knows (`wasManaged`).
- **Depends on / blocked by:** Nothing; land any time after the unification's mobile PR.
- **Origin:** /plan-eng-review of the roster-invite unification spec, 2026-08-27.

## Completed

_(none yet)_
