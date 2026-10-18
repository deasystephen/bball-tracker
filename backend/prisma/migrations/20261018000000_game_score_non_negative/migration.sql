-- Keep Game scores non-negative at the database level (#825).
-- Hand-written: Prisma does not model CHECK constraints in schema.prisma.
-- Fails on a database that already holds a negative score; check production first:
--   SELECT count(*) FROM "Game" WHERE "homeScore" < 0 OR "awayScore" < 0;
-- NOT VALID then VALIDATE: the add takes only a brief lock, and VALIDATE takes
-- SHARE UPDATE EXCLUSIVE, so it does not block the tracker's FOR UPDATE writes.
ALTER TABLE "Game" ADD CONSTRAINT "Game_score_non_negative_check" CHECK ("homeScore" >= 0 AND "awayScore" >= 0) NOT VALID;
ALTER TABLE "Game" VALIDATE CONSTRAINT "Game_score_non_negative_check";
