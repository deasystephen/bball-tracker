# Plan — #442 self-serve team creation + #443 league/season list scoping

GA blockers, milestone `v2.0 GA`. Reviewed 2026-08-30 via `/plan-ceo-review` (SELECTIVE EXPANSION)
then `/plan-eng-review`, with three adversarial rounds and two outside voices. Vision and
scope-decision record: `~/.gstack/projects/deasystephen-bball-tracker/ceo-plans/2026-08-30-self-serve-team-creation-league-scoping.md`.
Decision log `2168b35f`.

## 0. Ship order

**#30 ships first.** `PUBLIC_APP_URL=https://capyhoops.com` and the apex has no A record, so every
invite and guardian email in production already links to a dead host. Without it, #442 delivers a
coach who can create a team, type in player names and invite nobody, and
`.maestro/coach-onboarding.yaml` would pass anyway because it adds a managed player with no email.
Note the wildcard cert does not cover the apex, so an AWS-hosted apex needs an extended cert.

Then two PRs, **#442 before #443**:

```
PR1 (#442)  migration: League.personalOwnerId
            auto-provision + LeagueAdmin row, leagueAdminOf payload filter
            WHO x WHERE create gate
            mobile create + edit, Maestro
PR2 (#443)  scope listLeagues / listSeasons
            scope getLeagueById / getSeasonById
            real-Postgres access test
```

**The two PRs are one release.** #442 alone meets its written acceptance criterion (the "My teams"
default carries the coach through, and the dead-end copy is gone), but the intended experience — never
meeting the words league and season — needs #443. `areAllLeaguesPersonal` reads `GET /leagues`, which is
globally unscoped until #443, so a brand-new coach still sees a real league and the picker renders.
**`.maestro/coach-onboarding.yaml` therefore fails on #442 alone and is the gate for the pair.**

**Why #442 first.** Today an unaffiliated coach *can* create a team: the picker is unscoped and
`team-service.ts:244` lets any COACH write into any league. Ugly, but it works. Scoping the lists
first would return the empty set for exactly that user, so they would hit "No leagues available"
with auto-provision not yet shipped. #443-first buys a signup dead end for the length of the gap.
This order means nobody is ever worse off at any point.

Two PRs means **two production deploys**: `ci.yml`'s `detect-changes` filter covers `backend/**`,
so any non-markdown backend push rebuilds the image and rolls a new task-definition revision.

## 1. Problem

**#442.** `createTeamSchema.seasonId` is a required uuid (`api/teams/schemas.ts:14`); creating a
season needs `isLeagueAdmin` (`season-service.ts:112`); creating a league needs system ADMIN
(`league-service.ts:141`). A self-selected COACH is none of those.
`mobile/app/teams/create.tsx:225` renders the dead end.

**#443.** `listLeagues` (`league-service.ts:206`) and `listSeasons` (`season-service.ts:194`) build
their `where` from query filters only, with no caller-access clause, unlike `listTeams`/`listGames`.

**Worse than the issue states.** `team-service.ts:244` is
`if (!canCreate && user?.role !== 'COACH') throw Forbidden`, so any COACH may create a team in any
league, and that league's admin then gets read access to the roster including minors' names and
emails.

## 2. Design context (verified)

`PlayerStats` keys on `(playerId, gameId)`, `TeamStats` on `(teamId, gameId)`, `Game` on `teamId`.
**No `seasonId` anywhere in the stats or game tables.** `Team.seasonId` is a single required FK, so
**a `Team` row is a team-season**. The league contributes exactly one thing to stats: the label at
`stats-service.ts:1115`. There is no league-wide aggregation.

**Why `Season` stays**, stated correctly: not because it "carries the season boundary" (the finding
above shows nothing keys on it), but because making `Team.seasonId` nullable would ripple a null
through `TEAM_INCLUDE`, mobile `hasTeamPermission` (`team.season.league.id`), the `listTeams`
`leagueId` filter, the calendar feed and the stats label. A future reader relying on the first
reason would wrongly conclude seasons carry semantics they don't.

Deferred model rework (Club / TeamSeason / Competition) is #462.

## 3. Backend

### B1 — league access resolution (`utils/permissions.ts`)

```ts
async function buildLeagueAccess(userId, level)          // private
export async function getReadableLeagueIds(userId)       // list endpoints
export async function canReadLeague(userId, leagueId)    // boolean
export async function canWriteLeague(userId, leagueId)   // boolean
```

**Two named exports, not one function with a `level` argument.** The read set is a strict superset
of the write set, so a wrong-level call at a write site is a silent privilege escalation with no
type error and no crash, while the reverse is a loud reported bug. Named entry points make the
dangerous call greppable. One private builder keeps the branch set in a single place.

**Query from the Team side, not the League side.** Not
`league.findMany({ where: { OR: [ …nested some… ] } })` — that is a triple-nested correlated
`EXISTS` scanned across `League`, and after #442 `League` grows one row per coach. Instead:

```ts
team.findMany({
  where: <the existing listTeams access OR>,
  select: { season: { select: { leagueId: true } } },
})
```

bounded by the caller's own teams, **reusing the audited `listTeams:376-384` predicate verbatim**
rather than duplicating it into a second file where the two can drift. Union that with the caller's
`LeagueAdmin` league ids and their `personalOwnerId` league; dedupe in JS.

**`canReadLeague` / `canWriteLeague` are existence checks, not set membership.** B3's WHERE check
and the detail-endpoint 404 both ask a boolean question about one known league id, so
`league.count({ where: { id, OR: […] } })` is one indexed probe. Only the two list endpoints need
the array. Write level omits the `members` and guardian branches.

Every join path is already indexed: `Season(leagueId)`, `Team(seasonId)`, `TeamStaff(userId)`,
`TeamMember(playerId)`, `LeagueAdmin(userId)`, plus the new `personalOwnerId` unique index.

### B2 — scope the lists (PR2)

- `listLeagues(query, caller)` / `listSeasons(query, caller)` where `caller` is `{ id, role }`.
  `req.user` is the freshly-loaded DB row (`api/auth/middleware.ts:75`, `:107`), so the role is
  authoritative and no `isSystemAdmin` query is needed. Do not copy `listTeams:372`, which pays for one.
- Routes pass it (`api/leagues/routes.ts:67`, `api/seasons/routes.ts:65` — the only callers).
- ADMIN → unscoped, except personal leagues are excluded by default from **both** lists, with
  `includePersonal=true` to opt in. **Accepted incompleteness:** no UI toggle is planned, so admin
  list views become a deliberately incomplete picture of the database. Documented, not hidden.
- Non-ADMIN → `id: { in: ids }`, the same array passed to `count` and `findMany`. Empty set
  short-circuits to `{ total: 0 }` with no query.
- `search` / `leagueId` / `isActive` ANDed alongside: restructure to `{ AND: [access, filters] }`
  (today `league-service.ts:212` assigns `where.name` directly).
- **Deliberate width:** the id set means a member of one team sees every season of that league.
  Consistent with `getLeagueById`'s public branch. Say so in code.

### B3 — WHO may create × WHERE they may create (PR1)

The most important correction from review: an earlier draft deleted the only role gate on team
creation. Two independent checks, both required.

**WHO** — unchanged from today: system ADMIN, `role === 'COACH'`, or admin of any league. Without
it, `POST /teams { name }` has no target league to check, so any authenticated PLAYER or guardian
becomes Head Coach with all five flags (`createDefaultTeamRoles:383-423`). Today
`team-service.ts:244` 403s them.

**WHERE** — only when `seasonId` is supplied: `canWriteLeague(userId, season.leagueId)`. Never the
read set: a player or guardian rostered on a coach's team is a *member* of a team in that coach's
personal league, and the read set would let them plant a team inside someone else's container.

**Both the `season.findUnique` at `team-service.ts:226` and the WHERE check are conditional on
`seasonId` being present** — `findUnique({ where: { id: undefined } })` throws. Note the existing
404-on-missing-season fires before authorization, a different oracle from the 404-not-403 convention
used on league detail; left as is, flagged so it is not read as an accident.

### B4 — auto-provision (PR1)

`createTeamSchema.seasonId` → `.uuid().optional()`. **An omitted `seasonId` always resolves to the
caller's personal league**, regardless of other affiliations. The client sends `seasonId` only when
the user picked one.

Inside the **existing** `$transaction` (`team-service.ts:254`), after `SELECT … FOR UPDATE` (`:255`)
and **after** the tier/cap check (`:257-272`) so a capped user provisions nothing:

1. `league.upsert({ where: { personalOwnerId: userId }, create: { name: "<user.name>'s Teams",
   personalOwnerId: userId }, update: { personalOwnerId: userId } })`.
   **The no-op update writes the unique key back to itself.** Writing `name` would clobber a coach's
   rename on every subsequent team create, and the ability to rename is the whole justification for
   granting the `LeagueAdmin` row. A non-empty `update` is what gives Prisma a chance at the native
   `INSERT … ON CONFLICT` path (prisma/prisma#9972). Note `League.updatedAt` is `@updatedAt`, so it
   is bumped on every team create and stops being meaningful.
2. `leagueAdmin.upsert` on `@@unique([leagueId, userId])`. **Not nested inside the league upsert** —
   nested writes disable the native path.
3. `season.upsert` on `@@unique([leagueId, name])`, named for the current year, with an explicit
   `isActive: true` on create rather than relying on the schema default (the mobile picker filters
   `isActive: true`, `create.tsx:44`).
4. Existing `team.create` → `createDefaultTeamRoles` → `assignTeamRole`.

**No P2002 retry.** Earlier drafts built one and two adversarial rounds hardened it before anyone
asked whether the race exists. It does not: the transaction opens by locking the caller's `User`
row, `personalOwnerId` is unique per user, and that user's personal season lives only in their own
league, so the only writer that can contend is the same `userId` and it is serialized. Add a code
comment saying the lock is what makes this safe, so nobody later removes the lock believing a retry
covers them. The one theoretical contender is a system ADMIN creating a season in someone's personal
league via `POST /seasons`; note it, do not defend it.

**The `LeagueAdmin` row is granted.** Without it the container is unadministrable: no rename, no
second season, no delete when empty, and the league name would freeze the coach's display name at
creation. It also un-blocks rollover (#461) with no later permission change.

**Keep the admin area hidden:** filter leagues with a non-null `personalOwnerId` out of the
`leagueAdminOf` array. That is a 3-line change inside `getLeagueAdminOf` (`api/auth/routes.ts:30`),
the single local function all three session endpoints call. Backend authorization is untouched.
Documented as a deliberate client/server divergence.

**Migration:** `personalOwnerId String? @unique`, relation to `User`, `onDelete: SetNull`. Nullable
and additive, no backfill.

### B5 — detail scoping and payload hygiene

`getLeagueById` (`league-service.ts:179-200`) and `getSeasonById` (`season-service.ts:160-187`)
perform **no access check at all**: `isLeagueAdmin` only picks which `include` to use, and the
non-admin branch returns every season plus every `teams { id, name }` to any authenticated caller.
`TEAM_INCLUDE` is `season: { include: { league: true } }` (`team-service.ts:77-82`), so every team
member and guardian already holds the league uuid from the happy path.

- **PR2:** return **404** (not 403, matching `PlayerService.getPlayerById`) for an unaffiliated
  non-admin via `canReadLeague`. Record in the PR body that this deviates from #443's "do not change
  detail authorization" line, and why: #443 predates personal leagues.
- **PR1:** strip `personalOwnerId` from **every** league payload, not just `TEAM_INCLUDE`.
  `LEAGUE_INCLUDE`, `LEAGUE_LIST_INCLUDE`, `LEAGUE_PUBLIC_INCLUDE` and `LEAGUE_DETAIL_INCLUDE` all
  use `include`, which returns every League scalar, so the column would otherwise ship on
  `GET /leagues`, `GET /leagues/:id`, `POST /leagues` and `PATCH /leagues`. Convert to explicit
  `select`.
- **State the privacy limit honestly.** Hiding the uuid is not a privacy boundary while the league is
  named `"<user.name>'s Teams"`: the coach's display name reaches every player and guardian either
  way. The uuid is stripped because it is an internal id, not because it protects anything.

### B6 — observability (PR1)

Structured `info` when a personal league is provisioned (`userId`, `leagueId`, `seasonId`): the
signal that #442 works for real users. Structured `warn` when the B3 WHERE check denies a create
(`userId`, attempted `seasonId`, resolved `leagueId`): the tightened write scope is this work's main
regression risk and a wrongly denied coach would otherwise be silent.

## 4. Mobile (PR1)

**Branch on "every visible league is personal", not on league count** — after the first team the
personal league exists, so a count test would show team #2 a disclosure for a concept the coach
never chose. Add `isPersonal: boolean` to the league list payload as `personalOwnerId !== null`
(not `=== caller.id`, which mislabels other coaches' leagues under `includePersonal`).

- `mobile/app/teams/create.tsx`: all-personal or empty → name-only form, submit without `seasonId`.
  Otherwise → collapsed "League & season" disclosure. Delete "No leagues available. Create a league
  first." and "Ask a league admin to create a season first."
- **The disclosure must always offer "My teams (created on submit)" as the default.** A user who is a
  member of someone else's team and then switches to COACH sees exactly one league, not personal, and
  has no personal league yet: with nothing to default to and B3 correctly 403-ing that league, there
  would otherwise be no valid choice on the screen.
- **`mobile/app/teams/[id]/edit.tsx`** (`:22`, `:34`, `:253`) has the same picker and dead end. Hide
  it when every visible league is personal: `team-service.ts:437-457` gates a `seasonId` change on
  `isLeagueAdmin` of the target, so leaving it up invites a 403.
- `mobile/hooks/useTeams.ts:93` `CreateTeamInput.seasonId` → optional.

**Naming risk, decide at implementation:** `syncUser` sets `name` to the email local part when
WorkOS supplies no first/last name, and the name prompt is skippable. The population most likely to
hit that is brand-new self-signup coaches, so the modal outcome is a league called
`"jsmith92's Teams"` on every player's stats screen via `stats-service.ts:1115`. Either seed the
personal league name from a real display name at provision time, or accept it.

## 5. Tests

**CI already has a database.** `.github/workflows/ci.yml:53-96` provisions `postgres:15`, runs
`prisma migrate deploy`, and sets `DATABASE_URL` for `npm test -- --coverage`. The suite is mocked by
choice in `tests/setup.ts:221`, not by necessity. So the real-DB test goes in the **default run**
with `jest.unmock('../src/models')` and a real `PrismaClient`. No second jest config, no separate npm
script, and no "mock-driven test so the helper isn't uncovered" task.

**Break and must be updated:** `tests/services/league-service.test.ts:159-210`;
`tests/services/season-service.test.ts:228-268` (`toEqual` on the `where`);
`tests/api/leagues.test.ts:226-269`, `tests/api/seasons.test.ts:226-304`
(`toHaveBeenCalledWith` is arity-strict); `tests/services/team-service.test.ts:32-230` including
`:195-205`; `tests/api/teams.test.ts:90-159`; `tests/api/usage.test.ts:115-167`;
`tests/schemas/validation.test.ts:282` `it('should require seasonId')`.

**Real-Postgres access test — positive AND negative.** The negative case ("org A sees zero of org B")
cannot catch a *dropped* branch: delete the `members` branch and it still passes, and
under-permissiveness is the stated main regression risk. So: **one fixture user per branch, each
qualifying via exactly one branch** (league admin only / personal owner only / staff-of-team only /
member-of-team only / guardian only), each asserting they see the league; plus the org-A/org-B
negative case with and without `search`; plus write level asserting member-only and guardian-only
see nothing.

State in the test files: service tests mock the helper and assert wiring only; the helper's
correctness is tested only against real Postgres.

**Also new:**

- Empty id set short-circuits to `total: 0` without querying.
- ADMIN bypass; personal leagues excluded from both admin lists unless `includePersonal`.
- Personal-league resolver: creates on first call with the `LeagueAdmin` row, reuses on second,
  skipped when `seasonId` is supplied.
- **B3 both axes:** PLAYER with no `seasonId` → 403 (**REGRESSION** — works today,
  `team-service.ts:244`); guardian likewise; COACH with no `seasonId` → 201; member-of-a-team-in-league
  supplying that league's `seasonId` → 403; staff → 201; stranger → 403; capped FREE → 402 with **no
  league created**.
- `leagueAdminOf` excludes personal leagues on all three session endpoints.
- `personalOwnerId` absent from `GET /leagues`, `GET /leagues/:id` and team detail.
- `GET /seasons?leagueId=X` still works for a league admin after scoping.
- Mobile: create screen renders no pickers when every league is personal and submits without
  `seasonId`; the "My teams" default; edit screen hides the picker. **Second-team branch:** a Jest
  test for the all-personal case where the personal league already exists — the branch both
  adversarial reviewers caught, currently untested.
- **`.maestro/coach-onboarding.yaml`** — NEW (18 flows exist, this is not one). Dev-login as a fresh
  unaffiliated COACH → pick Coach → create team → add player → team detail renders, **then create a
  second team** to exercise the all-personal branch on device. **Requires a new seeded COACH with no
  team and no league**; Steve Kerr, Frank Vogel and Mike Brown are all rostered and `admin@` is a
  league admin (`seed.ts:273`). Also an AC on #441/#31 — write it once, here.
- **`.maestro/create-team.yaml`** — its league and season taps (lines 19-21) move behind the disclosure.

**Maestro is not a merge gate.** `.maestro/` is not in CI (#441), so calling `coach-onboarding.yaml`
"the GA gate" describes intent, not enforcement. It blocks nothing at merge until #441 lands.

**Coverage gate.** `jest.config.js:49-54` enforces `./src/services/` at branches 84 / functions 100 /
lines 96 / statements 96; `utils/permissions.ts` falls under the **global** gate (functions 86 /
branches 57). Run `npm test -- --coverage` before pushing.

## 6. Deployment and rollback

**There is no separate migrate step.** `docker/entrypoint.sh:5` runs `prisma migrate deploy` at
container start, so the deploy *is* the migration. Ordering them would need a one-off ECS task.
Harmless here: the column is additive and nullable.

Order: **#30 → PR1 (#442) backend deploy → mobile OTA → PR2 (#443) backend deploy.**

**Rollback is not clean, and any earlier claim that it was is withdrawn.** The column is inert; the
**data** is not. Once one team is created through B4, reverting PR1 leaves unscoped `listLeagues`
showing every coach's *personally named* league. **B4 is a one-way door from the first successful
create.** The OTA is not freely revertible either: an `eas update` rollback is another publish that
takes effect on the **second** launch, so there is a multi-hour tail during which old-JS/new-backend
and new-JS/old-backend both exist in the wild, and new-JS against a reverted backend is a 400 on the
primary create path with no feature flag to fall back to. Treat a bad backend deploy as roll-forward;
the ECS circuit breaker (#455) covers crash-class failures only.

## 7. Docs

CLAUDE.md "League / season / team / game authorization": list and detail endpoints are caller-scoped;
the WHO × WHERE create rule; the personal-league concept, its `LeagueAdmin` row and the
`leagueAdminOf` payload filter; the `Season`-stays reason from §2. `docs/plans/` spec as provenance.
Seed notes for the new fresh-coach user. Status comments on #442/#443 at merge naming which ACs were
reworded and why.

## 8. Known issues, documented not fixed

- `createLeague:150` / `updateLeague:269` enforce global `League.name` uniqueness in application
  code. Two coaches sharing a display name both get the same personal league name (allowed, no DB
  constraint), but an ADMIN later renaming a league into that name gets a 400.
- `onDelete: SetNull` clears `personalOwnerId`, so the league stops being "personal": it therefore
  **enters** the ADMIN default list, flips `isPersonal` to false and reappears in members' pickers,
  and its `LeagueAdmin` rows are gone so nobody can write to it. Reachable only via
  `prisma.user.delete`, which exists solely at `player-service.ts:472` for managed players, who
  cannot own a league, so this is close to unreachable.

## 9. Deferred to issues

#458 real-DB authorization harness (general), #459 team adoption plus the `PATCH seasonId`
retroactive-relabel bug, #460 staff invitations that create an account, #461 season rollover,
#462 the Club/TeamSeason/Competition model rework, #463 the `TeamStaff` multi-role inconsistency.

## Implementation Tasks

Synthesized from this review. `~/.gstack/projects/deasystephen-bball-tracker/tasks-eng-review-*.jsonl`

**Prerequisite**
- [ ] **T0 (P1)** — infra — Ship #30: apex A record + web deploy + apex cert. Blocks the funnel #442 opens.

**PR1 — #442**
- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — backend — Migration `League.personalOwnerId String? @unique`, relation to `User`, `onDelete: SetNull`
- [ ] **T2 (P1, human: ~2h / CC: ~15min)** — backend — `buildLeagueAccess` + `canReadLeague` / `canWriteLeague`, querying from the Team side and reusing the `listTeams` predicate
- [ ] **T3 (P1, human: ~3h / CC: ~20min)** — backend — WHO × WHERE create gate; conditional season lookup
- [ ] **T4 (P1, human: ~3h / CC: ~25min)** — backend — Auto-provision via three upserts in the existing transaction; no retry; comment the lock
- [ ] **T5 (P1, human: ~30min / CC: ~5min)** — backend — Filter personal leagues out of `getLeagueAdminOf`
- [ ] **T6 (P1, human: ~2h / CC: ~15min)** — backend — Convert the four `LEAGUE_*` includes to explicit `select`; strip `personalOwnerId`; add `isPersonal`
- [ ] **T7 (P2, human: ~1h / CC: ~10min)** — backend — Provision and denial logs
- [ ] **T8 (P1, human: ~4h / CC: ~30min)** — mobile — Create screen all-personal branch, name-only form, "My teams" default
- [ ] **T9 (P2, human: ~2h / CC: ~15min)** — mobile — Hide the picker on `teams/[id]/edit.tsx`
- [ ] **T10 (P1, human: ~4h / CC: ~30min)** — test — Seeded unaffiliated COACH; `coach-onboarding.yaml` incl. a second team; update `create-team.yaml`; second-team Jest test
- [ ] **T11 (P1, human: ~3h / CC: ~25min)** — test — B3 both axes incl. the PLAYER regression; provisioning; cap-creates-no-league

**PR2 — #443**
- [ ] **T12 (P1, human: ~4h / CC: ~25min)** — backend — Scope both lists; ADMIN bypass; `includePersonal`; `search` ANDed; empty-set short-circuit
- [ ] **T13 (P1, human: ~3h / CC: ~20min)** — backend — 404 unaffiliated non-admins on both detail endpoints
- [ ] **T14 (P1, human: ~1d / CC: ~40min)** — test — Real-Postgres access test in the default run: one fixture per branch (positive) plus org-A/org-B (negative), with and without `search`
- [ ] **T15 (P1, human: ~4h / CC: ~30min)** — test — Update the 8 suites that break on arity and exact-`where`
- [ ] **T16 (P2, human: ~2h / CC: ~15min)** — docs — CLAUDE.md, spec, seed notes

---

*Provenance: produced by `/plan-ceo-review` (SELECTIVE EXPANSION) then `/plan-eng-review` on
2026-08-30, with three adversarial review rounds and two independent outside voices. Follow-up work
was filed as #458-#463 rather than tracked here — GitHub issues are the source of truth for what is
left to do.*
