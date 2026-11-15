-- CreateEnum
CREATE TYPE "PracticeType" AS ENUM ('PRACTICE', 'OTHER');

-- CreateEnum
CREATE TYPE "PracticeStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PracticeFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY');

-- CreateTable
CREATE TABLE "PracticeSeries" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "type" "PracticeType" NOT NULL DEFAULT 'PRACTICE',
    "title" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "frequency" "PracticeFrequency" NOT NULL,
    "weekdays" INTEGER[],
    "startDate" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "endDate" DATE,
    "occurrenceCount" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSession" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seriesId" TEXT,
    "type" "PracticeType" NOT NULL DEFAULT 'PRACTICE',
    "title" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "PracticeStatus" NOT NULL DEFAULT 'SCHEDULED',
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeAvailability" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RsvpStatus" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PracticeSeries_teamId_idx" ON "PracticeSeries"("teamId");

-- CreateIndex
CREATE INDEX "PracticeSession_teamId_startsAt_idx" ON "PracticeSession"("teamId", "startsAt");

-- CreateIndex
CREATE INDEX "PracticeSession_seriesId_startsAt_idx" ON "PracticeSession"("seriesId", "startsAt");

-- CreateIndex
CREATE INDEX "PracticeSession_startsAt_idx" ON "PracticeSession"("startsAt");

-- CreateIndex
CREATE INDEX "PracticeAvailability_userId_idx" ON "PracticeAvailability"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeAvailability_sessionId_userId_key" ON "PracticeAvailability"("sessionId", "userId");

-- AddForeignKey
ALTER TABLE "PracticeSeries" ADD CONSTRAINT "PracticeSeries_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "PracticeSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeAvailability" ADD CONSTRAINT "PracticeAvailability_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PracticeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeAvailability" ADD CONSTRAINT "PracticeAvailability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
