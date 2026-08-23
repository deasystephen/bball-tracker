-- Store raw made/attempted shooting counts on TeamStats so season percentages
-- are weighted (sum made / sum attempted) rather than a mean of per-game
-- percentages (audit #26).
ALTER TABLE "TeamStats"
    ADD COLUMN "fieldGoalsMade" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "fieldGoalsAttempted" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "threePointersMade" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "threePointersAttempted" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "freeThrowsMade" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "freeThrowsAttempted" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows from the already-finalized PlayerStats for the same
-- game. TeamStats rows are only ever written by finalizeGameStats, which writes
-- PlayerStats in the same transaction, so the sums below reproduce exactly what
-- finalize would have stored. Rows with no PlayerStats (no player events) keep 0.
UPDATE "TeamStats" AS ts
SET
    "fieldGoalsMade" = agg.fgm,
    "fieldGoalsAttempted" = agg.fga,
    "threePointersMade" = agg.tpm,
    "threePointersAttempted" = agg.tpa,
    "freeThrowsMade" = agg.ftm,
    "freeThrowsAttempted" = agg.fta
FROM (
    SELECT
        "gameId",
        SUM("fieldGoalsMade") AS fgm,
        SUM("fieldGoalsAttempted") AS fga,
        SUM("threePointersMade") AS tpm,
        SUM("threePointersAttempted") AS tpa,
        SUM("freeThrowsMade") AS ftm,
        SUM("freeThrowsAttempted") AS fta
    FROM "PlayerStats"
    GROUP BY "gameId"
) AS agg
WHERE agg."gameId" = ts."gameId";
