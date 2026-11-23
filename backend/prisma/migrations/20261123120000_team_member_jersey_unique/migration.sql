-- One jersey number per team (#1087).
--
-- The rule has been enforced in the service layer since 2026-11-22 (a locked
-- check on every write that sets a number). This index makes it a database
-- guarantee. It is PARTIAL: a member with no number is not a holder, so any
-- number of members may have NULL. Prisma cannot express a partial unique
-- index, so it is hand-written and `schema.prisma` carries only a comment.
--
-- Step 1 makes the migration safe on any database. `docker/entrypoint.sh` runs
-- `prisma migrate deploy` on every start of the single API task, so a failed
-- CREATE UNIQUE INDEX would leave a failed migration that blocks every later
-- start, the previous image's included. Where two or more members of a team
-- share a number, the one who has held it longest keeps it and the others are
-- left with no number (the state the accept path already produces for a
-- number taken meanwhile); the coach sets a new one with "Edit jersey &
-- position". Production had no such pair when this was written (read-only
-- check, 2026-11-22, after the rule was live), so there this step changes
-- nothing; it matters for development databases with rows from before the rule.

-- Step 1: clear the later holders of a shared number.
UPDATE "TeamMember" AS later
SET "jerseyNumber" = NULL
WHERE later."jerseyNumber" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "TeamMember" AS earlier
    WHERE earlier."teamId" = later."teamId"
      AND earlier."jerseyNumber" = later."jerseyNumber"
      AND (earlier."createdAt", earlier."id") < (later."createdAt", later."id")
  );

-- Step 2: the guarantee.
CREATE UNIQUE INDEX "TeamMember_teamId_jerseyNumber_key"
  ON "TeamMember"("teamId", "jerseyNumber")
  WHERE "jerseyNumber" IS NOT NULL;
