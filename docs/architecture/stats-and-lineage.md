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
- **Tracked vs. finished games.** `GET /api/v1/stats/teams/:teamId` returns `gamesPlayed` (all `FINISHED`
  games = `wins + losses`, score-based) and `trackedGames` (finished games that have a `TeamStats` row).
  Per-game averages divide by `trackedGames`, so a game created directly as `FINISHED` with a score but no
  events (or finished with no events) counts in the record but does not deflate PPG/RPG/APG. Player season
  averages already divide by the player's own `PlayerStats` row count.
- `TeamStats` stores **raw shooting counts** (`fieldGoalsMade/Attempted`, `threePointersMade/Attempted`,
  `freeThrowsMade/Attempted`; FG includes 3P, matching `PlayerStats`) plus the per-game percentages.
  Season percentages in `GET /api/v1/stats/teams/:teamId` are **Σmade / Σattempted** across finalized games,
  never a mean of per-game percentages (a 1/1 game then a 1/9 game reads 20.0%, not 55.6%). Games with zero
  attempts contribute nothing to the denominator. The migration
  `20260822120000_team_stats_shooting_counts` backfilled existing rows from their `PlayerStats`.
- Use the exported `shootingPercentage(made, attempted)` helper (1 decimal, `0` when nothing attempted)
  rather than inlining the rounding.
- **Ties.** Equal scores are a `'T'`, never a loss: the season record is `{ wins, losses, ties }`
  (`gamesPlayed = wins + losses + ties`) and `recentGames[].result` is `'W' | 'L' | 'T'` (`gameResult()` in
  `stats-service.ts`). Mobile derives outcomes only through `mobile/utils/game-result.ts`
  (`getGameResult`, `getResultColor` — T is neutral `textSecondary`, `formatRecord`); never compare
  `homeScore > awayScore` inline in a screen. Screens show the tie count only when it is non-zero.

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
- Competitions (organizer-owned `Competition`, join code, `Game.competitionId`) are **designed in the
  plan and not built** (#492, gated on an organizer persona; the opponent-linkage half was
  **decided** on 2026-09-07 in `docs/plans/game-opponent-linkage.md`: two `Game` rows under a
  `Matchup` parent, `competitionId` required, opponent name and score **projected at read** from
  the linked row — never written across rows — and coach proposals count in standings only when
  both sides agree; built inside #492 PR 2/3). Tests:
  `tests/schemas/teams.test.ts`, lineage blocks in `tests/services/team-service.test.ts` and
  `tests/api/teams.test.ts`, real-Postgres assertions in `tests/integration/league-access.db.test.ts`;
  mobile `__tests__/app/team-bracket-fields.test.tsx`, `__tests__/utils/team-labels.test.ts`.
