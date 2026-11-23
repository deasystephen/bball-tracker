-- One jersey number per team (#1087).
--
-- The rule has been enforced in the service layer since 2026-11-22 (a locked
-- check on every write that sets a number). This index makes it a database
-- guarantee. It is PARTIAL: a member with no number is not a holder, so any
-- number of members may have NULL. Prisma cannot express a partial unique
-- index, so it is hand-written and `schema.prisma` carries only a comment.
--
-- Production was checked for duplicates before this migration was written
-- (read-only query, 2026-11-22: none among 14 members after the owner
-- renumbered two pairs). If this statement fails on another database, find
-- the pairs with:
--   SELECT "teamId", "jerseyNumber", count(*) FROM "TeamMember"
--   WHERE "jerseyNumber" IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- and renumber one of each pair ("Edit jersey & position").
CREATE UNIQUE INDEX "TeamMember_teamId_jerseyNumber_key"
  ON "TeamMember"("teamId", "jerseyNumber")
  WHERE "jerseyNumber" IS NOT NULL;
