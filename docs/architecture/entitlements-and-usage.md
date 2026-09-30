# Entitlements, usage metering and comped tiers

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Usage Metering & Tier Limits (#43)
- `services/usage-service.ts` exposes `getUsage(userId)` → per-feature `{ count, limit, limitReached }`. Counts are derived from live data at read time (no counter table) and cached in Redis for 60s (`utils/redis.ts` JSON helpers), invalidated on team create/delete.
- **Metered features**: `teams` (teams the user is staff on, vs tier `maxTeams`) and `seasons` (distinct seasons across those teams, vs tier `maxSeasons`). Limits are single-sourced from `USAGE_LIMITS` in `services/entitlements/index.ts` (read through `getUsageLimits`; `utils/entitlements.ts` is a re-export) — shared with the entitlement/feature-flag layer. `limit: null` means unlimited.
- **Current limits (#445): nothing is capped, on any tier.** `maxTeams` and `maxSeasons` are `Infinity` for FREE, PREMIUM and LEAGUE, so `GET /auth/me/usage` reports `limit: null` / `limitReached: false` for both metrics and a FREE user can create a 4th (or 40th) team. The FREE team cap of 3 was lifted because enforcement had shipped without any way to buy an upgrade — a dead-end paywall. The exported `FREE_TEAM_LIMIT` constant is gone. Re-introduce a cap only together with a real purchase flow (#41), by changing the number in `USAGE_LIMITS` and nowhere else.
- **Endpoint**: `GET /api/v1/auth/me/usage` returns all metered metrics for the current user's effective tier.
- **Enforcement (dormant, kept on purpose)**: the team-cap machinery is still mounted and works for any finite `maxTeams` — team create (`POST /api/v1/teams`) would block a user at/over their tier's cap with a **402** (`PaymentRequiredError`); admins bypass. With every tier at `Infinity` both checks return before the count query, so today it never fires. Its tests run against a finite limit swapped into `USAGE_LIMITS` (`tests/helpers.ts#withFiniteFreeTeamLimit`, `jest.replaceProperty`) — use that helper rather than deleting a cap test. **Seasons are metered but never capped** — the old FREE value of 1 was never enforced anywhere and rendered as a fake paywall (audit #81); season-history depth is the `FULL_SEASON_HISTORY` feature flag, not a usage limit. If a real season cap is ever wanted, enforce it where a team joins a new season and re-add the number in one place (`USAGE_LIMITS`).
- **Race-safe**: `requireTeamCreateLimit` is only a cheap pre-check. The authoritative check runs inside `TeamService.createTeam`'s `$transaction`, after `SELECT … FROM "User" … FOR UPDATE` on the caller's row, so concurrent creates serialize and can't exceed the cap (audit #49); it throws `PaymentRequiredError` (402, same `upgrade_required` body). Team + default roles + Head Coach staff row are written in that same transaction (no orphan teams, audit #70).
- **Grandfather rule** (applies whenever a tier has a finite limit): enforcement compares *current* count `>= limit` rather than `count + 1 > limit`. Users already over a cap keep all existing teams (never deleted/hidden) but cannot create new ones until under the limit or on a tier without one. Covered by tests in `tests/services/usage-service.test.ts` and `tests/api/usage.test.ts`.
- **Out of scope** (#43): per-day/per-hour rate limits, usage-based pricing, admin usage dashboards.

## Entitlements / Feature Gating

**Mobile has no entitlement UI (decision 2026-08-23).** `FeatureGate`, `UpgradePrompt` and `store/entitlements-store.ts` were dead code (never rendered/fetched) and were removed; the app exposes no entry point for the PREMIUM-gated features (team CSV export, calendar subscribe). The backend gates stay as the single source of truth. **No 402 is reachable from the app today**: the only one a user could hit was the FREE team cap on team create, lifted in #445 (the `isUpgradeRequiredError` branch in `app/teams/create.tsx` stays for the day a cap returns). `UsageMeter` on Profile renders plain counts ("4 · Unlimited", no bar, no CTA) because every limit is `null` (`__tests__/components/UsageMeter.test.tsx`). Re-add a client layer together with a real purchase flow when monetisation is scheduled.

Subscription feature gating has a **single source of truth**:
`backend/src/services/entitlements/index.ts`. It owns the `Feature` enum, the
feature->tier map (FREE / PREMIUM / LEAGUE) and the usage limits
(`USAGE_LIMITS`). Do not redefine tier rules elsewhere — import from there
(issue #43's usage metering reuses them).

**What FREE gets today (#445):** unlimited teams and seasons; none of the gated
features (team season-stats CSV export and calendar subscribe are PREMIUM and
answer 402 — neither has a client entry point). There is no `FREE_TEAM_LIMIT`
any more.

Enforcement lives in `backend/src/api/middleware/entitlements.ts` (the only entitlement middleware —
the old unmounted `requireFeature` / `requireUsageLimit` in `api/auth/middleware.ts`, which answered
403, are gone):

- `requireEntitlement(feature)` — gates a route behind a feature. On denial it
  returns **HTTP 402** with `{ code: 'upgrade_required', feature, currentTier, requiredTier }`.
  Applied to team season-stats CSV export (`STATS_EXPORT`) and calendar
  subscribe (`CALENDAR_SYNC`). System `ADMIN`s bypass all checks. Expired paid
  subscriptions resolve to an effective FREE tier.
- `requireTeamCreateLimit()` — enforces a tier's team cap on `POST /teams`
  when the tier has one. **No tier does since #445**, so it calls `next()`
  without a count query for everyone; it stays mounted so a finite `maxTeams`
  in `USAGE_LIMITS` is enforced again with no other change.
  **Grandfather rule:** a cap is checked only at create time. Users already
  over the limit KEEP their existing teams (nothing is deleted); they just
  cannot create new ones until under the cap or on an uncapped tier.

### Comping an account (admin-set tier, #445)

There is no purchase flow (#41), so the only way onto PREMIUM or LEAGUE is a
system ADMIN setting it — before #445 that meant hand-written SQL against
production RDS.

`PATCH /api/v1/admin/users/:userId/subscription` (`api/admin/routes.ts` →
`SubscriptionService.setSubscription`, `services/subscription-service.ts`):

- Body `{ tier: 'FREE' | 'PREMIUM' | 'LEAGUE', expiresAt?: string | null }`
  (`setSubscriptionSchema`; the tiers are the Prisma `SubscriptionTier` enum).
  **PREMIUM / LEAGUE require an `expiresAt` in the future** (ISO 8601 with `Z`
  or an offset): `isSubscriptionActive` treats a paid tier with no expiry as
  inactive, so a comp without a date would silently resolve to FREE. FREE
  takes no expiry (omit or `null`) and clears the stored one.
- **200** `{ success, user: { id, name, email, role, subscriptionTier,
  subscriptionExpiresAt }, effectiveTier }`; **400** invalid body / non-UUID
  `userId` / deleted account; **403** caller is not a system ADMIN; **404**
  unknown user. Errors are plain `{ error }` from the central handler.
- The write is `updateMany … WHERE deletedAt IS NULL` (the #444 invariant), the
  target's cached usage is invalidated, and every change logs
  `Subscription changed by admin` with actor, target and from/to tier + expiry
  — that log line is the audit trail.
- **How to comp someone:** sign in as an ADMIN, find the account id with
  `GET /api/v1/players?search=<email>&role=COACH` (ADMIN search matches email;
  pass the account's role, the list defaults to `PLAYER`), then
  ```bash
  curl -X PATCH https://api.hooplings.com/api/v1/admin/users/<userId>/subscription \
    -H "Authorization: Bearer <admin access token>" -H 'Content-Type: application/json' \
    -d '{"tier":"PREMIUM","expiresAt":"2027-09-30T00:00:00Z"}'
  ```
  To end a comp early send `{"tier":"FREE"}`; otherwise it lapses to an
  effective FREE tier on its own at `expiresAt`. A route was chosen over an
  operator script because RDS sits in a private subnet — a script needs a
  tunnel or a one-off ECS task, a route needs only an ADMIN token.
- Tests: `tests/api/admin-subscription.test.ts` (service un-mocked),
  `tests/schemas/admin-subscription.test.ts`,
  `tests/services/subscription-service.test.ts`.
