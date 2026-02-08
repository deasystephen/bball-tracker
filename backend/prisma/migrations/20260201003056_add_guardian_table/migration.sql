/*
  Warnings:

  - You are about to drop the column `season` on the `League` table. All the data in the column will be lost.
  - You are about to drop the column `year` on the `League` table. All the data in the column will be lost.
  - You are about to drop the column `coachId` on the `Team` table. All the data in the column will be lost.
  - You are about to drop the column `leagueId` on the `Team` table. All the data in the column will be lost.
  - Added the required column `seasonId` to the `Team` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "GuardianRelationship" AS ENUM ('MOTHER', 'FATHER', 'GUARDIAN', 'OTHER');

-- CreateEnum
CREATE TYPE "TeamRoleType" AS ENUM ('HEAD_COACH', 'ASSISTANT_COACH', 'TEAM_MANAGER', 'CUSTOM');

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_coachId_fkey";

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_leagueId_fkey";

-- DropIndex
DROP INDEX "League_year_season_idx";

-- DropIndex
DROP INDEX "Team_coachId_idx";

-- DropIndex
DROP INDEX "Team_leagueId_idx";

-- AlterTable
ALTER TABLE "League" DROP COLUMN "season",
DROP COLUMN "year";

-- AlterTable
ALTER TABLE "Team" DROP COLUMN "coachId",
DROP COLUMN "leagueId",
ADD COLUMN     "seasonId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Guardian" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "relationship" "GuardianRelationship" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueAdmin" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamRole" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "type" "TeamRoleType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "canManageTeam" BOOLEAN NOT NULL DEFAULT false,
    "canManageRoster" BOOLEAN NOT NULL DEFAULT false,
    "canTrackStats" BOOLEAN NOT NULL DEFAULT false,
    "canViewStats" BOOLEAN NOT NULL DEFAULT false,
    "canShareStats" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamStaff" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamStaff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Guardian_parentId_idx" ON "Guardian"("parentId");

-- CreateIndex
CREATE INDEX "Guardian_childId_idx" ON "Guardian"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "Guardian_parentId_childId_key" ON "Guardian"("parentId", "childId");

-- CreateIndex
CREATE INDEX "Season_leagueId_idx" ON "Season"("leagueId");

-- CreateIndex
CREATE INDEX "Season_isActive_idx" ON "Season"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Season_leagueId_name_key" ON "Season"("leagueId", "name");

-- CreateIndex
CREATE INDEX "LeagueAdmin_leagueId_idx" ON "LeagueAdmin"("leagueId");

-- CreateIndex
CREATE INDEX "LeagueAdmin_userId_idx" ON "LeagueAdmin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueAdmin_leagueId_userId_key" ON "LeagueAdmin"("leagueId", "userId");

-- CreateIndex
CREATE INDEX "TeamRole_teamId_idx" ON "TeamRole"("teamId");

-- CreateIndex
CREATE INDEX "TeamRole_type_idx" ON "TeamRole"("type");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRole_teamId_name_key" ON "TeamRole"("teamId", "name");

-- CreateIndex
CREATE INDEX "TeamStaff_teamId_idx" ON "TeamStaff"("teamId");

-- CreateIndex
CREATE INDEX "TeamStaff_userId_idx" ON "TeamStaff"("userId");

-- CreateIndex
CREATE INDEX "TeamStaff_roleId_idx" ON "TeamStaff"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamStaff_teamId_userId_roleId_key" ON "TeamStaff"("teamId", "userId", "roleId");

-- CreateIndex
CREATE INDEX "League_name_idx" ON "League"("name");

-- CreateIndex
CREATE INDEX "Team_seasonId_idx" ON "Team"("seasonId");

-- CreateIndex
CREATE INDEX "Team_name_idx" ON "Team"("name");

-- AddForeignKey
ALTER TABLE "Guardian" ADD CONSTRAINT "Guardian_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardian" ADD CONSTRAINT "Guardian_childId_fkey" FOREIGN KEY ("childId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueAdmin" ADD CONSTRAINT "LeagueAdmin_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueAdmin" ADD CONSTRAINT "LeagueAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRole" ADD CONSTRAINT "TeamRole_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStaff" ADD CONSTRAINT "TeamStaff_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStaff" ADD CONSTRAINT "TeamStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStaff" ADD CONSTRAINT "TeamStaff_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "TeamRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
