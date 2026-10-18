-- One staff role per user per team (#463).
-- Hand-written: the unique index cannot be created while a user still holds
-- several TeamStaff rows on one team, so the extra rows are removed first.
--
-- Survivor rule, per (teamId, userId) pair that holds more than one row:
--   1. keep the row whose role type is HEAD_COACH, if there is one;
--   2. otherwise keep the oldest row (lowest createdAt);
--   3. ties are broken by the lowest id, so the result is deterministic.
-- Every other row of that pair is deleted. A pair with one row is untouched.
-- Keeping the HEAD_COACH row means the delete can never leave a team without
-- the head coach it had.
--
-- The API has refused a second role since the staff endpoints shipped, so
-- production should hold no such pair; check before deploying:
--   SELECT "teamId", "userId", count(*) FROM "TeamStaff"
--   GROUP BY 1, 2 HAVING count(*) > 1;
-- tests/integration/team-staff-single-role.db.test.ts runs this DELETE
-- against multi-role rows and checks the survivors.
DELETE FROM "TeamStaff" AS s
USING (
  SELECT ts."id",
         ROW_NUMBER() OVER (
           PARTITION BY ts."teamId", ts."userId"
           ORDER BY (r."type" = 'HEAD_COACH') DESC, ts."createdAt" ASC, ts."id" ASC
         ) AS rn
  FROM "TeamStaff" AS ts
  JOIN "TeamRole" AS r ON r."id" = ts."roleId"
) AS ranked
WHERE s."id" = ranked."id"
  AND ranked.rn > 1;

-- DropIndex
DROP INDEX "TeamStaff_teamId_userId_roleId_key";

-- CreateIndex
CREATE UNIQUE INDEX "TeamStaff_teamId_userId_key" ON "TeamStaff"("teamId", "userId");
