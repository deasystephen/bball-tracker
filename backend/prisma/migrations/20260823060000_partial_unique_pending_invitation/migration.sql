-- Audit #22: the unique index on (teamId, playerId, status) applied to every
-- status, so a second REJECTED / CANCELLED / EXPIRED row for the same player
-- and team raised P2002 (HTTP 500) and the re-invite lifecycle got stuck.
-- Only PENDING needs to be unique. Prisma cannot express a partial unique
-- index, so it is written by hand here and documented in schema.prisma.

-- DropIndex
DROP INDEX "TeamInvitation_teamId_playerId_status_key";

-- CreateIndex (partial unique — only one PENDING invitation per team/player)
CREATE UNIQUE INDEX "TeamInvitation_pending_teamId_playerId_key"
  ON "TeamInvitation"("teamId", "playerId")
  WHERE "status" = 'PENDING';

-- CreateIndex (plain lookup index for the dedupe / listing queries)
CREATE INDEX "TeamInvitation_teamId_playerId_idx" ON "TeamInvitation"("teamId", "playerId");
