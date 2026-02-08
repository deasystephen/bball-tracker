-- CreateIndex
CREATE INDEX "Game_teamId_status_idx" ON "Game"("teamId", "status");

-- CreateIndex
CREATE INDEX "Game_teamId_date_idx" ON "Game"("teamId", "date");

-- CreateIndex
CREATE INDEX "GameEvent_gameId_playerId_idx" ON "GameEvent"("gameId", "playerId");

-- CreateIndex
CREATE INDEX "GameEvent_gameId_eventType_idx" ON "GameEvent"("gameId", "eventType");

-- CreateIndex
CREATE INDEX "Team_createdAt_idx" ON "Team"("createdAt");

-- CreateIndex
CREATE INDEX "TeamInvitation_status_expiresAt_idx" ON "TeamInvitation"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "PlayerStats" ADD CONSTRAINT "PlayerStats_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerStats" ADD CONSTRAINT "PlayerStats_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStats" ADD CONSTRAINT "TeamStats_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStats" ADD CONSTRAINT "TeamStats_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
