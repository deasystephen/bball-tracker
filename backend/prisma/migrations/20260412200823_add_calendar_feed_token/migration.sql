-- CreateTable
CREATE TABLE "CalendarFeedToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarFeedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarFeedToken_token_key" ON "CalendarFeedToken"("token");

-- CreateIndex
CREATE INDEX "CalendarFeedToken_userId_idx" ON "CalendarFeedToken"("userId");

-- CreateIndex
CREATE INDEX "CalendarFeedToken_teamId_idx" ON "CalendarFeedToken"("teamId");

-- CreateIndex
CREATE INDEX "CalendarFeedToken_userId_teamId_idx" ON "CalendarFeedToken"("userId", "teamId");

-- CreateIndex
CREATE INDEX "CalendarFeedToken_token_idx" ON "CalendarFeedToken"("token");

-- AddForeignKey
ALTER TABLE "CalendarFeedToken" ADD CONSTRAINT "CalendarFeedToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarFeedToken" ADD CONSTRAINT "CalendarFeedToken_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
