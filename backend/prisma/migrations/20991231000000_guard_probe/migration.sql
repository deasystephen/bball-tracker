-- Throwaway. Proves the migration backfill guard (#493) fails in CI. Never merge.
-- On an empty table both statements succeed and the schema ends unchanged, so the
-- empty-database job passes. On a table that holds rows the first statement fails.
ALTER TABLE "Team" ADD COLUMN "guardProbe" TEXT NOT NULL;
ALTER TABLE "Team" DROP COLUMN "guardProbe";
