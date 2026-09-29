-- Throwaway. Proves the migration backfill guard (#493) fails in CI. Never merge.
ALTER TABLE "Team" ADD COLUMN "guardProbe" TEXT NOT NULL;
