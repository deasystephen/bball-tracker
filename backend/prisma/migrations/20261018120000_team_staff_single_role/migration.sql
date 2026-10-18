-- One staff role per user per team (#463).
-- Hand-written: the unique index cannot be created while a user still holds
-- several TeamStaff rows on one team, so the extra rows are removed first.
--
-- Survivor rule, per (teamId, userId) pair that holds more than one row.
-- Before this migration getTeamPermissions granted the UNION of a user's
-- roles, so the survivor is the row that grants the most of that union:
--   1. most permission flags first (canManageTeam, canManageRoster,
--      canTrackStats, canViewStats, canShareStats);
--   2. then role type: HEAD_COACH, ASSISTANT_COACH, TEAM_MANAGER, CUSTOM
--      (keeps HEAD_COACH over an equally-flagged ASSISTANT_COACH, so staff
--      management and the last-head-coach guard keep their head coach);
--   3. then the oldest row (lowest createdAt);
--   4. then the lowest id, so the result is deterministic.
-- Every other row of that pair is deleted. A pair with one row is untouched.
--
-- The API has refused a second role since the staff endpoints shipped, so
-- production should hold no such pair; check before deploying:
--   SELECT "teamId", "userId", count(*) FROM "TeamStaff"
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Audit and retry: the DELETE reports how many rows it removed with RAISE
-- WARNING, not NOTICE: `prisma migrate deploy` prints neither, but WARNING is
-- at Postgres's default log_min_messages, so the count lands in the server
-- log (on RDS, the instance's postgresql log). Every statement is idempotent (the DELETE finds nothing the second
-- time, the index statements use IF [NOT] EXISTS), so after a failure here
-- (for example a different-role insert by the old task between the DELETE and
-- CREATE UNIQUE INDEX during the rolling deploy) the migration can be marked
-- rolled back and applied again.
--
-- tests/integration/team-staff-single-role.db.test.ts runs the block between
-- the BEGIN/END DELETE sentinels against multi-role rows and checks the
-- survivors; keep the sentinels.
-- BEGIN DELETE
DO $$
DECLARE
  deleted_rows integer;
BEGIN
  DELETE FROM "TeamStaff" AS s
  USING (
    SELECT ts."id",
           ROW_NUMBER() OVER (
             PARTITION BY ts."teamId", ts."userId"
             ORDER BY
               (r."canManageTeam"::int + r."canManageRoster"::int + r."canTrackStats"::int
                 + r."canViewStats"::int + r."canShareStats"::int) DESC,
               CASE r."type"
                 WHEN 'HEAD_COACH' THEN 0
                 WHEN 'ASSISTANT_COACH' THEN 1
                 WHEN 'TEAM_MANAGER' THEN 2
                 ELSE 3
               END ASC,
               ts."createdAt" ASC,
               ts."id" ASC
           ) AS rn
    FROM "TeamStaff" AS ts
    JOIN "TeamRole" AS r ON r."id" = ts."roleId"
  ) AS ranked
  WHERE s."id" = ranked."id"
    AND ranked.rn > 1;

  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RAISE WARNING 'TeamStaff single-role: deleted % rows', deleted_rows;
END $$;
-- END DELETE

-- DropIndex
DROP INDEX IF EXISTS "TeamStaff_teamId_userId_roleId_key";

-- DropIndex: redundant with the leading column of the new unique index.
DROP INDEX IF EXISTS "TeamStaff_teamId_idx";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TeamStaff_teamId_userId_key" ON "TeamStaff"("teamId", "userId");
