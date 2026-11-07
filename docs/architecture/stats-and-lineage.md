# Stats and team lineage

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Stats (finalized box scores & season aggregates)

- `StatsService.finalizeGameStats(gameId)` (`backend/src/services/stats-service.ts`) recomputes a game's
  box score from `GameEvent`s and upserts `PlayerStats` (one row per player) and `TeamStats` (one row per
  game). It runs when a game is `PATCH`ed to `FINISHED` **and** whenever an event is created or deleted on a
  game that is already `FINISHED` (`GameEventService` → `StatsService.refinalizeIfFinished`; post-finish
  edits are allowed, not rejected — the stored box score just follows them). It is idempotent: `PlayerStats`
  rows for players with no remaining events are deleted, and a game with **no** player events ends up with no
  `PlayerStats`/`TeamStats` rows at all.
- **Finalization serializes on the game row (#724).** `finalizeGameStats` reads the event log and writes
  `PlayerStats`/`TeamStats` in one interactive transaction that first takes the same `lockGameRow`
  `FOR UPDATE` lock as every event write (`docs/architecture/live-games.md`, Game score), with
  `calculatePlayerStats(gameId, tx)` reading through the transaction. Overlapping post-finish edits
  therefore finalize one after another, and the last to commit has read every committed event. The event
  path decides whether to re-finalize from the `status` read under its own lock, not from the access-check
  row, so a `PATCH status=FINISHED` committing around an event write is never missed: either the write saw
  `FINISHED` and re-finalizes, or the PATCH's own finalization runs after the write and reads it.
  `tests/integration/stats-finalize.db.test.ts` runs both races against Postgres. The transaction has an
  explicit `FINALIZE_TRANSACTION_TIMEOUT_MS` (15 s) clock instead of Prisma's 5 s default, because a timeout
  is swallowed by the callers and leaves a FINISHED game without a box score, and raises the pool-wide 4 s
  `lock_timeout` to `FINALIZE_LOCK_TIMEOUT_MS` (14 s) with `SET LOCAL` as its first statement for the same
  reason (#944; `docs/architecture/backend-services.md`, pool section); `PlayerStats` rows are
  replaced with one `deleteMany` and one `createMany` to keep the time under the lock short.
- **Legacy SHOT rows change value on the next re-finalize (#723).** Since the shared point rule in
  `backend/src/utils/shot-points.ts`, a stored SHOT whose `points` is not 1, 2, 3, missing or `null` counts
  nowhere (before: as 2 in the box score and as its raw value in `homeScore`), and a `made` that is not a
  boolean is a miss (before: any truthy value was a make). The API has rejected both shapes since #723, but
  rows written earlier keep them, and the next event write or finalize on such a game changes its stored
  score and box score. Find them with:

  ```sql
  SELECT "gameId", "id", "metadata" FROM "GameEvent"
  WHERE "eventType" = 'SHOT'
    AND (
      ("metadata" ? 'made' AND jsonb_typeof("metadata"->'made') NOT IN ('boolean', 'null'))
      OR ("metadata" ? 'points' AND jsonb_typeof("metadata"->'points') <> 'null'
          AND NOT (jsonb_typeof("metadata"->'points') = 'number' AND "metadata"->>'points' IN ('1', '2', '3')))
    )
  ORDER BY "gameId";
  ```
- **Tracked vs. finished games.** `GET /api/v1/stats/teams/:teamId` returns `gamesPlayed` (all `FINISHED`
  games = `wins + losses + ties`, score-based) and `trackedGames` (finished games that have a `TeamStats` row).
  Per-game averages divide by `trackedGames`, so a game created directly as `FINISHED` with a score but no
  events (or finished with no events) counts in the record but does not deflate PPG/RPG/APG. Player season
  averages already divide by the player's own `PlayerStats` row count.
- `TeamStats` stores **raw shooting counts** (`fieldGoalsMade/Attempted`, `threePointersMade/Attempted`,
  `freeThrowsMade/Attempted`; FG includes 3P, matching `PlayerStats`) plus the per-game percentages.
  Season percentages in `GET /api/v1/stats/teams/:teamId` are **Σmade / Σattempted** across finalized games,
  never a mean of per-game percentages (a 1/1 game then a 1/9 game reads 20.0%, not 55.6%). Games with zero
  attempts contribute nothing to the denominator. The migration
  `20260822120000_team_stats_shooting_counts` backfilled existing rows from their `PlayerStats`.
- Use the exported `shootingPercentage(made, attempted)` (1 decimal, `0` when nothing attempted) and
  `perGame(total, games)` (1 decimal, `0` when no games) helpers rather than inlining the rounding. Every
  aggregation in `stats-service.ts` calls them: the box score and team totals directly, the team season
  stats directly, and the player season, roster, overall and career aggregations through the private
  `derivePlayerAverages(totals, gamesPlayed)` (percentages, six per-game averages and efficiency, which is
  `perGame` of the EFF sum). `tests/utils/stats-rounding-guard.test.ts` fails on any `Math.round(` in the
  file outside the two helpers (#682).
- **Ties.** Equal scores are a `'T'`, never a loss: the season record is `{ wins, losses, ties }`
  (`gamesPlayed = wins + losses + ties`) and `recentGames[].result` is `'W' | 'L' | 'T'` (`gameResult()` in
  `stats-service.ts`). Mobile derives outcomes only through `mobile/utils/game-result.ts`
  (`getGameResult`, `getResultColor` — T is neutral `textSecondary`, `formatRecord`); never compare
  `homeScore > awayScore` inline in a screen. `mobile/__tests__/utils/game-result-guard.test.ts` reads
  `app/`, `components/`, `hooks/`, `store/` and `utils/` and fails on any score-vs-score comparison (ordering or
  equality) or score difference outside the helper (#673). Screens show the tie count only when it is non-zero.

## Team lineage (#462, `docs/plans/team-lineage-and-competition.md`)

- **A `Team` row IS a team-season.** No game or stats table carries a `seasonId`; `Team.seasonId` is a
  single required FK, so every roster, staff, game and stats row is already per-season. Persistent
  identity across seasons is the additive `TeamLineage` parent (`Team.lineageId`, required,
  `@@unique([lineageId, seasonId])`), **not** a `Team`/`TeamSeason` split — the split would re-point
  nine FK tables and break `/teams` for the binaries in the field for no capability. The lineage is a
  pure identity (id + timestamps) and carries no club: a team's club is the league of the season it
  plays in, so `permissions.ts` keeps one access path. Rollover (#461) and adoption (#459) create a
  **new `Team` row with the same `lineageId`** and copy the per-season tables; they never move
  `seasonId` on a row with history.
- `createTeam` creates the lineage inside its existing `$transaction`, after the cap check (two
  statements — Prisma won't mix the scalar `seasonId` with a nested relation write). `deleteTeam` runs
  in a `$transaction` and deletes the lineage when no other team-season references it; `Season`/`League`
  cascades bypass that and leave harmless orphan lineages. `PATCH /teams/:id { seasonId }` pre-checks
  for a sibling of the lineage in the target season and answers **400** (`SEASON_SIBLING_MESSAGE`); a
  lost race on the unique index maps P2002 to the same 400.
- **`ageGroup` / `gender` live on `Team`** (per-season: a U12 team is U13 next year). `gender` is the
  Prisma enum `TeamGender { BOYS, GIRLS, COED }`; `ageGroup` is trimmed free text, max 20 (U14 / 14U /
  Grade 7 — conventions differ by region, so no enum). On update `null` clears, absent leaves unchanged
  (same rule as jersey/position). Mobile derives labels ONLY via `utils/team-labels.ts`
  (`formatTeamBracket` → "U14 · Boys", `genderOptions`); the gender pills reuse `components/SortPills`
  with `labelPrefix="Gender: "` (a11y "Gender: Boys", asserted by `.maestro/create-team.yaml`).
- **Migration `20260906120000_team_lineage` is hand-written** (enum → table → nullable column →
  `UPDATE … gen_random_uuid()` → `INSERT … SELECT` → `SET NOT NULL` → FK → unique index). Prisma would
  emit `ADD COLUMN … NOT NULL`, which fails on a populated table and crash-loops the API at container
  start. **CI applies migrations to an empty database**, so a backfill's data statements first run on
  real rows in production unless rehearsed: restore a snapshot per `docs/runbooks/rds-backup-restore.md`
  (stop before the Secrets Manager repoint), `migrate deploy` from the branch, assert
  `SELECT count(*) FROM "Team" WHERE "lineageId" IS NULL` = 0. Since #493 the migration backfill
  guard runs every new migration against seeded rows on each pull request (see `../testing/migration-backfill-guard.md`); it is the first check, and the snapshot rehearsal is still
  the one that meets production's rows.
- **Season rollover (#461, `POST /teams/:id/rollover`, `TeamService.rolloverTeam`).** "Start next
  season" creates a **new `Team` row in the target season with the same `lineageId`** and copies, in
  one `$transaction`: every `TeamRole` (custom ones too, with their flags, via `createManyAndReturn`),
  every `TeamStaff` row (re-pointed at the new role ids by name; a role that fails to map aborts the
  whole rollover rather than drop the coach) and every `TeamMember` (jersey number, `0` included, and
  position). Accounts with `deletedAt` set (tombstones, #444) are not carried. **Not carried:** pending
  `TeamInvitation`s (the new row starts with none; the coach re-invites from Add Player, so a carried
  managed player reads "Not invited" until then), `CalendarFeedToken`s (a subscription stays on the
  season it was issued for), `Announcement`s, games, stats and competition entries (#492). Guardians
  attach to the child, not the team, so they need nothing; a guardian resend is lineage-scoped already
  (`guardians.md`). The **old row is left untouched and stays listed** (no archive): its games and
  `PlayerStats` are last season's, and the player career view (`GET /stats/players/:id`,
  `StatsService.getPlayerOverallStats`) reads them per membership, so a rolled-over player shows one
  row per team-season. `tests/integration/team-rollover.db.test.ts` proves it against Postgres.
  - **Body:** exactly one of `seasonId` or `seasonName`. A `seasonId` must be in the team's own league;
    one in another league answers the **same 404 as a missing one** (`Season not found`), so season ids
    cannot be probed. A `seasonName` matches an existing season of the team's league on
    `lower(trim(name))` (raw SQL, `findSeasonIdByName`; never Prisma's `mode: 'insensitive'`, which
    compiles to an unescaped `ILIKE`), so "spring 2025" finds "Spring 2025"; with no match it creates
    the season (`isActive: true`). The team's current season is 400. Optional `name`, `ageGroup`,
    `gender`: absent carries last season's value, `null` clears the bracket (a U12 team is U13 next
    year). Schema `rolloverTeamSchema`.
  - **Who:** `canManageStaff` on the source team (head coach, league admin, system admin; an assistant
    coach is refused, as for a season move), checked first and **again behind the team row lock**.
    WHERE is implied: the target season must be in the team's own league, and anyone who passes
    `canManageStaff` there already passes `canWriteLeague` (a league admin directly, a head coach as
    staff on a team in it, a system admin always), so the service does not call it. **Creating** a season
    additionally needs `isLeagueAdmin`, the `POST /seasons` rule, so a coach in a club league can roll
    into a season the club made but never mint one; a personal-league owner holds a `LeagueAdmin` row
    (#442) and can. Moving a team to another league is adoption (#459), not rollover.
  - **Only the latest team-season continues a team.** `latestTeamSeasonId` orders the lineage's rows by
    their season's `startDate`, with the season's `createdAt` standing in when there is none (personal-league
    seasons have no dates), then the newer team row, then the larger id, so the answer is deterministic.
    Rolling any other row answers **409 `not_latest_season`** with no ids (`NotLatestSeasonError`):
    otherwise a coach removed from this season's row could roll last season's row, where they were still
    head coach, forward and come back. The rule is checked behind the locks after the idempotent
    "existing row" answer (so a repeat from last season's screen still gets 200 `created: false`) and
    before any season is created. `GET /teams/:id` carries `isLatestInLineage`, and the mobile team screen
    offers "Start next season" only when it is `true` (absent counts as no).
  - **Season creation** goes through `season-service.ts#findOrCreateSeason`, the same helper as
    `POST /seasons`: it locks the League row, matches the name with `findSeasonIdByName`
    (`lower(trim(name))`, oldest first; existing near-duplicates are left as they are, no migration),
    inserts with `createMany({ skipDuplicates: true })` (`INSERT … ON CONFLICT DO NOTHING`, so a concurrent
    same-name create by a writer that does not take the lock, the personal-league upsert, is reused
    instead of a P2002 that would abort the transaction), reads the row back by its exact name and logs
    `Season created` when it inserted. `POST /seasons` answers **409** for a name that is taken, case and
    surrounding spaces ignored. `seasonCreated` in `Team rolled over` says whether this rollover inserted
    the season. A **picked** season (`seasonId`) is re-checked behind a `FOR KEY SHARE` lock, which also
    holds it against a delete until commit; gone or moved to another league answers the same 404.
  - **Locks**, in order, all in one transaction:
    1. every `User` the copy will reference (the caller, the source's staff and players), read
       unlocked and then locked in id order with `lockUsers` (`FOR NO KEY UPDATE`, which conflicts with
       account deletion's `FOR UPDATE`). Account deletion locks Users and then Teams, and the copy's FK
       inserts need a share lock on every carried User, so taking the Users before the team keeps one
       order and the two never deadlock. **Only users in that locked set and still live (`deletedAt`
       null) are carried**: a member or coach added between the unlocked read and the lock is simply
       not carried (re-add them on the new team), and one deleted meanwhile is dropped.
    2. the source `Team` row (`lockTeamRow`, the lock staff removals and role changes take); the source
       is **re-read behind it** and `canManageStaff` is re-checked **through the transaction** (`db`
       parameter on `canManageStaff` / `isSystemAdmin` / `isHeadCoach`, default the shared client), so a
       staff edit, season move or delete is seen whole (a deleted source answers 404; a move into another
       league since the pre-checks answers 400).
    3. the `TeamLineage` row (`FOR NO KEY UPDATE`), so two rollovers of one lineage serialize.
    4. the `League` row, only when a season is created (inside `findOrCreateSeason`); the name is
       re-matched behind it, so no two creates can mint two case variants.
  - **Idempotent.** Behind the locks it probes `lineageId_seasonId`. When the lineage already has a row
    in the target season nothing is written, and the route answers **200 `{ created: false, team }`**
    with that row, but only to a caller with `canAccessTeam` and `canManageRoster` **on that row**
    (the source-team check says nothing about it: a coach removed from next season's row must not read
    its roster emails). Anyone else gets **409 `team_season_exists`** with no id (`TeamSeasonExistsError`). A real create is **201 `{ created: true, team }`**. There is no P2002 retry: the
    transaction runs inside `createOrConflict` naming `Team_lineageId_seasonId_key` (or its columns), so
    a P2002 on that unique (a concurrent season move into the same season) answers the season move's
    400 (`SEASON_SIBLING_MESSAGE`) and a P2002 on any other unique propagates.
  - **Entitlements: not metered.** The tier team cap counts distinct **lineages**
    (`countDistinctStaffTeams`, a `team.groupBy` on `lineageId`; `usage-service.computeCounts` uses the
    same rule), so a rollover adds no team to anyone's count, and the route is not behind
    `requireTeamCreateLimit`. Counting team-season rows would charge a coach for every past season, and a
    capped coach could never continue their own team; a new team is a new lineage, so `POST /teams`
    counts exactly as before. After commit the usage cache of the caller and every carried staff member
    is invalidated (their season count changes).
  - Domain event `Team rolled over` (`teamId` new row, `fromTeamId`, `lineageId`, `fromSeasonId`,
    `toSeasonId`, `created`, `seasonCreated`, `members`, `staff` counts).
  - **Mobile:** "Start next season" on the team screen for `canManageStaff` callers →
    `app/teams/[id]/next-season.tsx` (button and deep-link guard also require `isLatestInLineage`). The
    season is a **picker** over the league's **active** seasons (`GET /seasons?leagueId=&isActive=true`,
    caller-scoped; the team's own season is never offered) and is sent as `seasonId`.
    "New season" with a free-text name (sent as `seasonName`, prefilled by
    `utils/season-name.ts#suggestNextSeasonName`, which moves every year forward: "2026" → "2027",
    "2026-27" → "2027-28", "Fall 2026 - Spring 2027" → "Fall 2027 - Spring 2028") is offered only
    when that list answers `canCreate: true` (`SeasonService.listSeasons` adds it to a
    `leagueId`-filtered list, computed in the same `Promise.all`: `isLeagueAdmin`, the `POST /seasons`
    rule). The seasons request waits for the team's league (`useSeasons(…, { enabled })`), and a
    `leagueId`-filtered list does not hide personal-league seasons from a system ADMIN. The suggested season is
    preselected when the league has it (case-insensitive), else "New season" when offered. A club coach
    whose league has no other season is told to ask a league admin. Team name and age group are
    prefilled and editable. Back and Cancel use `useGoBack('/teams/<id>')`. `useRolloverTeam` fires
    `team_rolled_over` and invalidates the team lists, usage, season lists, every player career view
    (`statsKeys.playerOveralls()`) and player details, then the form replaces itself with the new
    team-season.
  - Tests: `tests/services/team-rollover.test.ts`, `tests/api/teams-rollover.test.ts` (incl. the
    removed-coach 409, the cross-league 404 and no 402 at the cap), `rolloverTeamSchema` in
    `tests/schemas/teams.test.ts`, `canCreate` in `tests/services/season-service.test.ts` and
    `tests/api/seasons.test.ts`, the real-database suite above (copy, idempotence, concurrent
    rollovers, tombstones not carried, case-insensitive match, cross-league 404, removed-coach 409 with
    no id, removed coach rolling last season's row (`not_latest_season`), `isLatestInLineage`, the
    `POST /seasons` 409 for a case variant, one lineage counting as one team, a same-name `POST /seasons`
    race, career view); mobile
    `__tests__/app/team-next-season.test.tsx`, `__tests__/hooks/useRolloverTeam.runtime.test.tsx`,
    `__tests__/utils/season-name.test.ts`; Maestro `.maestro/team-rollover.yaml`.
- Competitions (organizer-owned `Competition`, join code, `Game.competitionId`) are **designed in the
  plan and not built** (#492, gated on an organizer persona; the opponent-linkage half was
  **decided** on 2026-09-07 in `docs/plans/game-opponent-linkage.md`: two `Game` rows under a
  `Matchup` parent, `competitionId` required, opponent name and score **projected at read** from
  the linked row — never written across rows — and coach proposals count in standings only when
  both sides agree; built inside #492 PR 2/3). Tests:
  `tests/schemas/teams.test.ts`, lineage blocks in `tests/services/team-service.test.ts` and
  `tests/api/teams.test.ts`, real-Postgres assertions in `tests/integration/league-access.db.test.ts`;
  mobile `__tests__/app/team-bracket-fields.test.tsx`, `__tests__/utils/team-labels.test.ts`.
