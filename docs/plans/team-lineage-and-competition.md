# Team lineage and competitions (#462, reduced scope)

Source: `/plan-eng-review` of issue #462 on 2026-09-06, including an outside-voice challenge whose
accepted corrections are folded in below. The issue proposed five deltas (rename `League` to
`Club`, split `Team` into `Team` + `TeamSeason`, add `Competition`, add `ageGroup`/`gender`, add
`Game.opponentTeamId`). This plan is the reduced scope agreed in that review:

- **Build now (PR 1, PR 2):** an additive `TeamLineage` parent instead of the split, plus
  `ageGroup`/`gender` on the team-season row, plus a small secret-strip refactor.
- **Designed here, built later (own issue):** `Competition` with entries, join code and game
  tagging. Two triggers gate the build: the `Game.opponentTeamId` one-row-or-two decision, and
  an organizer persona (today only a system ADMIN can create a League, and personal-league owners
  never see the admin screens, so no self-serve coach can organize a competition).
- **Deferred to their own issues:** the `League` → `Club` rename and `Game.opponentTeamId`.

Related: #459 (adoption into a club), #461 (season rollover), both of which build on the lineage
decided here; #29 (RDS restore drill), closed by PR 1's migration rehearsal.

## Problem

The schema models a club and calls it a `League`, and models no competition at all. A `Team`
row is already a team-season (no game or stats table carries a `seasonId`; `Team.seasonId` is a
single required FK), so the only thing missing on the team side is a persistent identity that
links one season's row to the next. On the competition side nothing exists: `Game.opponent` is
free text and the league contributes exactly one label (`stats-service.ts:1115`).

## Decisions (from the review)

| # | Decision | Why |
|---|----------|-----|
| D2 | Keep `Team` as the team-season row; add `TeamLineage` instead of splitting | The split re-points nine FK tables and breaks `/teams` for the five binaries in the field (#25 to #30) for no capability. Lineage is additive and backfills with one `UPDATE` + one `INSERT … SELECT`. |
| 1 | `TeamLineage` carries **no** club. Club derives from `Team.seasonId → Season.leagueId` | One access path (`permissions.ts:96`). Adoption (#459) becomes "new team-season in the club's season, same lineage", never an edit to history. |
| 2 | Lineage is a pure identity (`id`, timestamps). `ageGroup`/`gender` live on `Team` | Age group and name change season to season (U12 becomes U13). Rollover and adoption copy the per-season tables (members, staff, roles, calendar tokens, announcements); that is #461/#459 scope, exactly as it was before this plan. |
| 3 | `Competition` belongs to an organizer `League`'s `Season`; competition admin = `isLeagueAdmin(organizer)` | Reuses two entities and one predicate. No new admin table, no fourth branch in list scoping. |
| 4 | New `competitionAccessWhere`; entries expose team `{ id, name }` only; `getTeamPermissions` unchanged | Entering a competition must not hand the organizer the roster or emails (#442 failure by another door). |
| 5 | Entry by **join code** (typeable, plus a link that pre-fills it), entered by the team's head coach | Since #443 an organizer cannot list other clubs' teams. Invite-by-email is #459's design; build it once, later. |
| 6 | Nullable `Game.competitionId`, validated against the entry table | Lets coaches tag games and organizers see self-reported results. Fixtures and standings need opponent linkage, which is deferred. |
| 7 | `Team.lineageId` is **required**; hand-written migration | Prisma emits `ADD COLUMN … NOT NULL`, which fails on a populated table and crash-loops the API at container start. |
| 8 | Generalise `omitToken` → `omitSecret(row, key)`; both secrets use it | One greppable strip; DRY where drift hurts. (The rate-limit key generator is **not** generalised: the join endpoint is keyed by caller, see decision 5.) |
| 9 | Explicit delete and race rules (below) | Cascade defaults would delete games on competition delete and 500 on a double join. |
| 10 | `gender`: enum `TeamGender { BOYS, GIRLS, COED }`; `ageGroup`: trimmed `String` max 20 | Enum where the domain is closed, bounded string where it is open (U14 / 14U / Grade 7). |
| 11 | Real-Postgres test `tests/integration/competition-access.db.test.ts` | Mocked suites cannot fail for a dropped access branch (`tests/setup.ts` mocks Prisma globally). |
| 12 | Maestro `.maestro/competition-join.yaml`; extend `team-detail.yaml` and `create-team.yaml`; seed fixtures with reset | Repo rule: new mobile functionality ships with a flow; flows that write rows need a seed reset. |
| 13 | `GET /teams/:id` includes `competitions: [{ id, name, seasonName }]` | One request for the team screen; bounded join; taste call. |
| T1 | **Build PR 1-2 now; PR 3-4 become a designed issue** | Outside voice: no self-serve coach can organize a competition today, and without opponent linkage the competition page is a union of self-reported rows. Design is complete and recorded; code waits for the two triggers above. |
| T2 | PR 1's migration is rehearsed against a restored RDS snapshot (guided), which is also the #29 drill; a CI seeded-migration guard is filed as its own issue | CI applies migrations to an empty database, so the backfill first meets real rows in production otherwise. |
| T3 | Keep `@@unique([lineageId, seasonId])`; `updateTeam`'s season move checks for a sibling in the target season → 400, P2002 mapped to the same 400 | The invariant is what makes rollover idempotent; the live move path had no P2002 handling. |
| T4 | Participants (staff, members, guardians of entered teams) can read a competition: team names, games, scores; never people fields | Deliberate product decision: families see the league they play in. Recorded, tested one fixture per branch. |

## Target shape

```
League (club; personal league = club of one; ALSO the organizer of competitions)
   │
   └─< Season ──────────────┬─< Team (= team-season: name, ageGroup?, gender?, seasonId, lineageId)
        │                   │      │
        │                   │      ├─< TeamMember / TeamStaff / TeamRole / TeamInvitation
        │                   │      ├─< Game (competitionId?)  ── opponentTeamId: DEFERRED
        │                   │      ├─< TeamStats / Announcement / CalendarFeedToken
        │                   │      └── lineageId ──> TeamLineage (id, createdAt, updatedAt)
        │                   │
        └─< Competition ────┘  (name, seasonId = ORGANIZER's season, joinCode)   ← DESIGNED, NOT BUILT YET
                 │
                 └─< CompetitionEntry (competitionId, teamId)   @@unique([competitionId, teamId])
```

Reading the diagram: a team-season sits in exactly one club (through its own season) and may be
entered in any number of competitions run by any organizer. A competition's period is its
organizer's season. The entered team's club and the organizer's club are usually different; a
team may only enter a competition whose organizer season overlaps its own season's dates (when
both have dates).

### Access model (competition half)

```
                 organizer admins          people on an entered team          anyone else
                 (isLeagueAdmin of         (staff | member | guardian
                  competition.season.       via teamAccessWhere)
                  leagueId, or ADMIN)
Competition      read + write              read                               404
  joinCode       visible (explicit select) never                              never
Entries          team { id, name }         team { id, name }                  404
Competition      game rows, team name,     same                               404
  games          opponent, score, status
Entered team's   404 (unchanged:           unchanged                          unchanged
  detail/roster  getTeamPermissions
                 has no competition branch)
```

The middle column is a deliberate widening (T4): a family in club A can see club B's team name,
game dates, opponents and scores inside a shared competition, and nothing else.

## PR 1: TeamLineage, ageGroup, gender

### Schema

```prisma
enum TeamGender { BOYS GIRLS COED }

model TeamLineage {
  id        String   @id @default(uuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  teams     Team[]
  // Persistent identity only. Everything a coach can change season to season
  // (name, ageGroup, gender) lives on Team, which is the team-season row.
  // Rollover (#461) and adoption (#459) create a NEW Team row with the same
  // lineageId; they never move Team.seasonId on a row with history.
}

model Team {
  // existing fields …
  lineageId String
  ageGroup  String?     // trimmed, max 20; free text by design (U14 / 14U / Grade 7)
  gender    TeamGender?
  lineage   TeamLineage @relation(fields: [lineageId], references: [id], onDelete: Restrict)
  @@unique([lineageId, seasonId])   // a lineage appears at most once per season
  @@index([lineageId])
}
```

### Migration (hand-written; never let Prisma generate it)

```sql
CREATE TYPE "TeamGender" AS ENUM ('BOYS', 'GIRLS', 'COED');
CREATE TABLE "TeamLineage" (
  "id"        TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TeamLineage_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Team" ADD COLUMN "lineageId" TEXT;                       -- nullable first
UPDATE "Team" SET "lineageId" = gen_random_uuid();                    -- one id per team, no pairing step
INSERT INTO "TeamLineage" ("id", "createdAt", "updatedAt")
  SELECT "lineageId", now(), now() FROM "Team";
ALTER TABLE "Team" ALTER COLUMN "lineageId" SET NOT NULL;
ALTER TABLE "Team" ADD CONSTRAINT "Team_lineageId_fkey"
  FOREIGN KEY ("lineageId") REFERENCES "TeamLineage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Team_lineageId_seasonId_key" ON "Team"("lineageId", "seasonId");
CREATE INDEX "Team_lineageId_idx" ON "Team"("lineageId");
ALTER TABLE "Team" ADD COLUMN "ageGroup" TEXT, ADD COLUMN "gender" "TeamGender";
```

**Evidence (T2).** CI's `migrate deploy` runs against an empty database, so the backfill cannot
fail there. Before merge, restore the latest automated production snapshot to a throwaway
instance per `docs/runbooks/rds-backup-restore.md` Procedure A (stop **before** the Secrets
Manager repoint), run `prisma migrate deploy` from the PR branch against it (one-off ECS task or
local run with the runbook's CA bundle), assert `SELECT count(*) FROM "Team" WHERE "lineageId" IS
NULL` is 0 and the unique index exists, record time-to-restore in the runbook's drill log, tear
the instance down, close #29. Production then applies the same file in `docker/entrypoint.sh`
under the #455 circuit breaker.

### Service and API

| Route | Gate | Notes |
|-------|------|-------|
| `POST /teams` | unchanged | Accept `ageGroup?` and `gender?`. Creates the lineage with `lineage: { create: {} }` inside the existing `$transaction` (`team-service.ts:402`), after the cap check, so a capped user provisions nothing. |
| `PATCH /teams/:id` | unchanged | `ageGroup?` (`z.string().trim().min(1).max(20).nullable().optional()`), `gender?` (`z.nativeEnum(TeamGender).nullable().optional()`); `null` clears (same rule as `updateTeamMemberSchema`). **Season move (T3):** if another `Team` with the same `lineageId` already sits in the target season → 400 `This team already has a row in that season`; a lost race on the unique index maps P2002 → the same 400. |
| `DELETE /teams/:id` | unchanged | Now a `$transaction`: delete the team, then delete its lineage if no other `Team` references it. |
| `GET /teams/:id`, `GET /teams` | unchanged | Add `lineageId`, `ageGroup`, `gender`. Additive; old binaries ignore them. |

Delete rules: `Season → Team` and `League → Season` cascades bypass `deleteTeam`, so lineages
orphaned that way remain as harmless rows; `deleteTeam` is the only cleanup path. File a sweep
only if they ever matter.

Seed: `seed.ts:420, 512` and `tests/integration/league-access.db.test.ts` team creates gain the
nested lineage create.

### Mobile (PR 1)

- `hooks/useTeams.ts` `Team` type: optional `lineageId`, `ageGroup`, `gender`.
- `teams/create.tsx`, `teams/[id]/edit.tsx`: Age group text input (max 20) and Gender chips
  (`SortPills`-style selected state, 44pt targets); i18n keys in `en.json` and `es.json`.
- Ships as an OTA after the backend deploy is verified.

## PR 2: `omitSecret`

`api/invitations/serializers.ts#omitToken` becomes a one-line wrapper over a shared
`omitSecret<T, K extends keyof T>(row: T, key: K): Omit<T, K>`; `tests/api/invitations.test.ts`
token-absence asserts are the regression suite. No rate-limit changes. Independent of PR 1.

## Competition design (build deferred; file as its own issue with this section verbatim)

### Triggers to start the build

1. `Game.opponentTeamId` decided: one `Game` row or two for a game between two in-system teams
   (each side tracks its own events today; `TeamStats` keys on `(teamId, gameId)`).
2. An organizer persona exists: at least one non-personal league admin in production, or a product
   decision that self-serve coaches may organize (which means surfacing personal-league owners in
   `admin/*` or a different entry point).

### Schema

```prisma
model Competition {
  id        String   @id @default(uuid())
  seasonId  String   // the ORGANIZER's season; period + admin set come from it
  name      String
  joinCode  String   @unique   // 8 chars, unambiguous alphabet; shown as XXXX-XXXX; never in list/detail payloads
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  season    Season   @relation(fields: [seasonId], references: [id], onDelete: Cascade)
  entries   CompetitionEntry[]
  games     Game[]
  @@unique([seasonId, name])
  @@index([seasonId])
}

model CompetitionEntry {
  id            String      @id @default(uuid())
  competitionId String
  teamId        String
  createdAt     DateTime    @default(now())
  competition   Competition @relation(fields: [competitionId], references: [id], onDelete: Cascade)
  team          Team        @relation(fields: [teamId], references: [id], onDelete: Cascade)
  @@unique([competitionId, teamId])
  @@index([teamId])
}

model Game {
  // existing fields …
  competitionId String?
  competition   Competition? @relation(fields: [competitionId], references: [id], onDelete: SetNull)
  @@index([competitionId])
}
```

### Join code

- 8 characters from an unambiguous alphabet (no `0/O/1/I`), rendered `XXXX-XXXX`, typeable on a
  phone. Also shared as `https://hooplings.com/join/<code>`, which opens the app (existing
  Universal Link plumbing) with the code pre-filled on the team picker.
- Guessing is bounded by the endpoint, not by length: `POST /competitions/join` is rate-limited
  **per user id + IP** (about 10 attempts / 15 min; the route is authenticated so the caller is
  known). Unknown and rotated codes answer the same generic 404. Organizer can rotate at any time.
- Read back only through `COMPETITION_ADMIN_SELECT` for organizer admins; every other select omits
  it and `omitSecret(row, 'joinCode')` strips it again at the route layer.

### Entry rule

A team may join only when its season and the organizer's season overlap (when both have dates;
undated seasons are unconstrained, documented). Rollover (#461) never carries entries: the new
team-season row joins the new competition with its own code.

### Delete and race rules

| Event | Rule |
|-------|------|
| Organizer removes an entry, or a head coach withdraws | One transaction: `game.updateMany({ where: { teamId, competitionId }, data: { competitionId: null } })` then delete the entry. |
| Competition deleted | Entries cascade; tagged games get `competitionId = null` (`SetNull`). Games are never deleted by a competition. |
| Team deleted | Entries cascade (FK). |
| Double join (same team, same code) | Pre-check the entry; a lost race on `@@unique([competitionId, teamId])` maps P2002 → 400 `Team is already entered`, retried outside the transaction (P2002 inside a Prisma transaction aborts it). |

### API surface (all additive; `/leagues` untouched)

| Route | Gate | Notes |
|-------|------|-------|
| `POST /competitions { seasonId, name }` | `isLeagueAdmin(season.leagueId)` | 201; `joinCode` generated server-side; 400 on duplicate name in season. |
| `GET /competitions?seasonId=` | readers per access model | Never includes `joinCode`. |
| `GET /competitions/:id` | readers | 404 for non-readers (never 403). |
| `PATCH /competitions/:id { name }`, `DELETE /competitions/:id`, `POST /competitions/:id/rotate-code` | organizer admin | Rotate returns the new code once. |
| `POST /competitions/join { code, teamId }` | `canManageStaff(teamId)` | Per-user + IP rate limit; season-overlap rule; 404 unknown code; 400 already entered. |
| `DELETE /competitions/:id/entries/:teamId` | organizer admin **or** `canManageStaff(teamId)` | Rules above. |
| `GET /competitions/:id/games` | readers | `{ id, date, status, homeScore, awayScore, opponent, team: { id, name } }`. No people. Self-reported per team until opponent linkage exists. |
| `POST /games`, `PATCH /games/:id` | unchanged | `competitionId?` nullable; 400 `Team is not entered in this competition` without an entry row; `null` clears. |
| `GET /teams/:id` | unchanged | Adds `competitions: [{ id, name, seasonName }]` (decision 13). Game create/edit read the picker from `useTeam(teamId)`, not from `GAME_DETAIL_INCLUDE`. |

`utils/permissions.ts` gains, next to the league-access block (and that comment block's
read/write table gets a competition row):

```
canWriteCompetition(userId, competitionId) = ADMIN | isLeagueAdmin(competition.season.leagueId)
canReadCompetition(userId, competitionId)  = canWriteCompetition | any Team with an entry
                                             matching teamAccessWhere(userId, childIds)
competitionAccessWhere(userId, childIds)   = { OR: [ { season: { league: { admins: { some: { userId } } } } },
                                                     { entries: { some: { team: teamAccessWhere(...) } } } ] }
```

### Mobile (competition build)

- `teams/[id].tsx`: "Competitions" chip row; **Join competition** action (code entry sheet,
  `components/ActionMenu` pattern; pre-filled from the `/join/<code>` link) rendered only when
  `canManageStaff(team, userId, userRole, leagueAdminOf)`. Derivations in
  `utils/competition-scope.ts` (`canJoinCompetition`, `isEntered`), never inline.
- `admin/leagues/[id].tsx`: per-season competitions list; create; `admin/competitions/[id].tsx`
  with join code (copy + share link), rotate, entries with remove, games list.
- `games/create.tsx` and game edit: optional Competition picker from `useTeam(teamId)`; hidden
  when empty. Game detail shows a competition badge.
- `hooks/useCompetitions.ts`: `useCompetitions(seasonId)`, `useCompetition(id)`,
  `useCreateCompetition`, `useJoinCompetition`, `useRemoveEntry`, `useRotateJoinCode`,
  `useCompetitionGames`. Join/remove invalidate `teamKeys.detail(teamId)` and the competition keys.

### Tests (competition build)

- `tests/schemas/competitions.test.ts`; `tests/services/competition-service.test.ts` (every
  branch above); `tests/api/competitions.test.ts` (full request cycle; `joinCode` absent from
  create/list/get/entries/games responses, mirroring `tests/api/invitations.test.ts`; 404 vs 400
  vs 403 per the gate table; **the per-user rate limit gets its own API test** because it is
  load-bearing for an 8-character code); `tests/services/game-service.test.ts` regression (bodies
  without `competitionId` unchanged) plus with-entry / without-entry / `null` cases;
  `tests/utils/permissions.test.ts` unit cases.
- `tests/integration/competition-access.db.test.ts` (real Postgres, `jest.unmock`): **one
  distinct club per access branch** (organizer admin, admin of an unrelated league, head coach,
  member, guardian of a member whose child's team is in a club the guardian does not own,
  unaffiliated); positive and negative per branch, so removing any branch fails exactly one test;
  plus the entry-removal null-out and the join race against the real unique index.
- Mobile Jest (real i18n): join control gating; picker hidden with no entries;
  `competition-scope` helpers; `useCompetitions` runtime invalidations.
- Maestro `.maestro/competition-join.yaml` (Frank Vogel joins the seeded competition on the
  Lakers, asserts the row-anchored chip; Steph Curry branch asserts the control is absent). Seed
  adds an organizer competition under Downtown Youth Basketball League with a fixed join code and
  deletes Lakers entries on every run.

## Tests (PR 1 and PR 2)

- `tests/schemas/teams.test.ts`: `ageGroup` trim/max/null, `gender` enum/null.
- `tests/services/team-service.test.ts`: **regression** `createTeam` transaction includes the
  nested lineage create (personal-league path too); `updateTeam` sets/clears the new fields;
  season move with a sibling in the target season → 400, P2002 → 400; **regression**
  `deleteTeam` runs in a `$transaction`, removes an orphaned lineage, keeps a shared one.
- `tests/api/teams.test.ts`: request cycle for the new fields and the new 400.
- `tests/api/invitations.test.ts`: **regression** token-absence asserts pass after `omitToken`
  becomes a wrapper (PR 2).
- `tests/integration/league-access.db.test.ts` (extend): every team has exactly one lineage after
  `migrate deploy`; `@@unique(lineageId, seasonId)` rejects a duplicate.
- Mobile Jest (real i18n): team create/edit render, save and clear the two fields.
- Maestro: `team-detail.yaml` and `create-team.yaml` extended for age group / gender.

## Sequencing

```
PR 1  TeamLineage + ageGroup/gender + updateTeam guard   (backend, seed, mobile edit fields, OTA)
      ↳ migration rehearsed on a restored snapshot first (T2) → closes #29
PR 2  omitSecret refactor                                 (tiny, invitations only)
──────── build stops here for now ────────
#492  competition build (this design, verbatim) — gated on #494 and an organizer persona
#493  CI seeded-migration guard (seed teams, then migrate deploy the newest migration)
#494  Game.opponentTeamId — one row or two (also unblocks fixtures and standings)
#495  League → Club rename (keep /leagues mounted as an alias for old builds), after #492
#462  stays open as the parent until #492 and #494 close; PR 1 references it without "Closes".
#461 rollover and #459 adoption can start after PR 1 lands.
```

PR 1 and PR 2 are independent (different modules) and can run in parallel worktrees; base both
on `main`, never stacked (stacked PRs get no CI here). PR 1 carries a schema migration: verify
the rollout COMPLETED and `/health` reports `db: ok` before publishing the OTA.

## NOT in scope

- **Competition build** (PRs 3-4 of the original plan): designed above, deferred until the
  opponent decision and an organizer persona exist. Without those it is a badge only admin-created
  leagues can issue, over self-reported results.
- **Rename `League` → `Club`.** ~800 references across backend, tests and mobile, plus the
  `/leagues` routes and `leagueAdminOf` field that five live binaries read. Buys clarity, not
  capability. Own issue; keep `/leagues` mounted as an alias for old builds (#418 pattern).
- **`Game.opponentTeamId`, head-to-head, standings.** One-row-or-two is a design of its own. Own
  issue; it is trigger 1 for the competition build.
- **Organizer-initiated invites (invite-by-email to a team).** Same machinery #459 adoption
  needs; design once there.
- **Season rollover (#461)** and **adoption (#459)**: consume the lineage; not built here. Both
  copy the per-season tables (members, staff, roles, calendar tokens, announcements), as they
  would have without this plan.
- **CI seeded-migration guard**: own issue; protects every future backfill migration.
- **Orphan-lineage sweep** for season/league cascades: harmless rows; file only if they matter.
- **Age-group normalisation** ("U14" = "14U"): free text by decision 10.
- **Competition-level stats or leaderboards**: needs opponent linkage first.

## What already exists

| Sub-problem | Existing code | Plan |
|-------------|---------------|------|
| Per-season identity | `Team` row is already a team-season | Reused as-is; lineage added |
| Competition period + admin set | `Season` (name, dates) + `LeagueAdmin` + `isLeagueAdmin` | Reused; no new admin table |
| Cross-club entry secret | Invitation token discipline (`INVITATION_SELECT`, `omitToken`) | Strip generalised (`omitSecret`); rate limit keyed by caller instead |
| Deep link into the app | Universal Links (`applinks:hooplings.com`, `/invite/<token>`) | Reused for `/join/<code>` |
| Team-side read predicate | `teamAccessWhere` | Reused inside `competitionAccessWhere` |
| Real-DB authz test harness | `tests/integration/league-access.db.test.ts` | Pattern copied; extended for lineage |
| Snapshot restore procedure | `docs/runbooks/rds-backup-restore.md` Procedure A | Used for the migration rehearsal; drill log filled |
| Transactional create with cap check | `TeamService.createTeam` `$transaction` | Lineage create nested inside it |
| Nullable-clears schema rule | `updateTeamMemberSchema` | Same shape for `ageGroup`/`gender` |
| Pill/chip UI | `components/SortPills`, `components/ActionMenu` | Reused for gender chips and the join sheet |

## Failure modes

| Path | Realistic failure | Test | Handling | User sees |
|------|-------------------|------|----------|-----------|
| Lineage migration | Backfill leaves a null → `SET NOT NULL` fails at container start | Snapshot rehearsal (T2); db test after deploy | Circuit breaker rolls back | Red deploy job, no outage |
| `createTeam` nested create | Cap check throws after lineage create | existing 402 test | Same transaction, rolled back | 402 message unchanged |
| `updateTeam` season move | Sibling already in target season | service + API test | Pre-check → 400; P2002 → 400 | Clear message |
| `deleteTeam` | Lineage delete fails (sibling exists) | service test | Only deletes when unreferenced | Team deleted, lineage kept |
| Join by code (deferred) | Guessing | API test on the per-user limit | 429 after ~10 tries | "Too many attempts" |
| Join by code (deferred) | Double tap | db test (real unique index) | Pre-check + P2002 → 400 | One entry |
| Remove entry (deferred) | Tagged games keep pointing at competition | api + db test | Same-transaction null-out | Badge gone |
| Competition delete (deferred) | Games deleted by cascade | api test | `SetNull` | Games intact |
| `competitionAccessWhere` (deferred) | Dropped branch | db test, one club per branch | n/a | Right people see it |
| Old binary | Unknown fields in payload | manual (build #30) | Additive only | Nothing |

No failure mode is untested, unhandled and silent. **Critical gaps: 0.**

## Worktree parallelization

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| PR 1 lineage + fields | `prisma/`, `services/team-service`, `api/teams`, `tests/`, `mobile/app/teams`, `mobile/hooks/useTeams`, `docs/runbooks` (drill log) | — |
| PR 2 omitSecret | `api/invitations/serializers`, `tests/api/invitations` | — |

Lane A: PR 1. Lane B: PR 2. Launch both in parallel worktrees; no shared modules. The
competition build, when it starts, depends on both.

## Diagrams to embed in code

- `prisma/schema.prisma`: the target-shape diagram above as a comment on `TeamLineage`.
- `services/team-service.ts`: a short comment on `updateTeam`'s season move explaining the
  sibling check and why the unique index exists (rollover idempotence).
- When the competition build starts: extend the `utils/permissions.ts` league-access comment
  block with the competition read/write rows, and put the delete-and-race table in
  `services/competition-service.ts`.

## Acceptance criteria (mapped to #462)

- [ ] A club team can enter a competition without leaving its club. **Designed; build deferred to its own issue.**
- [x] Historical team-seasons keep their own stats and labels. (Already true; lineage makes rollover a new row; the season-move guard keeps it that way.)
- [ ] `Game` can reference an in-system opponent. **Deferred**, own issue.
- [x] Migration plan covers games, stats, rosters, invitations and calendar feeds. (Nothing re-keyed; PR 1 touches only `Team`; rehearsed on a snapshot before merge.)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (2026-08-30, #442/#443 plan that spawned #462) | CLEAR | 5 proposals, 2 accepted, 6 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 4 (outside voice, Claude subagent; latest 2026-09-06) | issues_found | 12 findings, 4 tensions accepted, 6 corrections folded, 2 restated |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 for this plan (2026-09-06) | CLEAR (PLAN) | 17 issues (6 arch, 4 code quality, 2 test, 1 perf, 4 outside-voice tensions), 0 critical gaps, mode SCOPE_REDUCED |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** Outside voice (Claude subagent, same model family) reversed the build decision: PRs 3-4 (competitions) deferred to #492; join-code rate limit re-keyed by caller; CI empty-DB migration gap fixed via snapshot rehearsal (#29) and #493; season-move sibling guard added; participants' cross-club read recorded as a product decision.
- **CROSS-MODEL:** Both reviewers agree on the lineage-instead-of-split architecture, the organizer-as-League model and the narrow read scope; they disagreed only on build timing, resolved in favour of deferral.
- **VERDICT:** ENG CLEARED for PR 1 and PR 2 — ready to implement. Competition build (#492) requires its own eng review when its triggers hold.

NO UNRESOLVED DECISIONS
