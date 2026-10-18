-- One staff role per user per team (#463).
-- Hand-written: the unique index cannot be created while a user still holds
-- several TeamStaff rows on one team, so the extra rows are removed first.
--
-- Survivor rule, per (teamId, userId) pair that holds more than one row,
-- keeping the most privileged role so nobody loses access they had:
--   1. role type: HEAD_COACH, then ASSISTANT_COACH, then TEAM_MANAGER, then CUSTOM;
--   2. within a type (two CUSTOM roles), more permission flags first;
--   3. then the oldest row (lowest createdAt);
--   4. then the lowest id, so the result is deterministic.
-- Every other row of that pair is deleted. A pair with one row is untouched.
-- Before this migration getTeamPermissions granted the UNION of a user's
-- roles; the survivor is the role that grants the most of that union.
--
-- The API has refused a second role since the staff endpoints shipped, so
-- production should hold no such pair; check before deploying:
--   SELECT "teamId", "userId", count(*) FROM "TeamStaff"
--   GROUP BY 1, 2 HAVING count(*) > 1;
-- tests/integration/team-staff-single-role.db.test.ts runs the statement
-- between the BEGIN/END DELETE sentinels against multi-role rows and checks
-- the survivors; keep the sentinels.
-- BEGIN DELETE
DELETE FROM "TeamStaff" AS s
USING (
  SELECT ts."id",
         ROW_NUMBER() OVER (
           PARTITION BY ts."teamId", ts."userId"
           ORDER BY
             CASE r."type"
               WHEN 'HEAD_COACH' THEN 0
               WHEN 'ASSISTANT_COACH' THEN 1
               WHEN 'TEAM_MANAGER' THEN 2
               ELSE 3
             END ASC,
             (r."canManageTeam"::int + r."canManageRoster"::int + r."canTrackStats"::int
               + r."canViewStats"::int + r."canShareStats"::int) DESC,
             ts."createdAt" ASC,
             ts."id" ASC
         ) AS rn
  FROM "TeamStaff" AS ts
  JOIN "TeamRole" AS r ON r."id" = ts."roleId"
) AS ranked
WHERE s."id" = ranked."id"
  AND ranked.rn > 1;
-- END DELETE

-- DropIndex
DROP INDEX "TeamStaff_teamId_userId_roleId_key";

-- DropIndex: redundant with the leading column of the new unique index.
DROP INDEX "TeamStaff_teamId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "TeamStaff_teamId_userId_key" ON "TeamStaff"("teamId", "userId");
