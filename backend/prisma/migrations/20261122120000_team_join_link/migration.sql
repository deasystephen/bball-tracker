-- Team join links (#210): a reusable, revocable link a coach shares so
-- families ask to join, and the join requests a roster manager approves.
-- Two new, empty tables and one new enum: additive, no backfill.

-- CreateEnum
CREATE TYPE "JoinRequestKind" AS ENUM ('SELF', 'CHILD');

-- CreateTable
CREATE TABLE "TeamJoinLink" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamJoinLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamJoinRequest" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "kind" "JoinRequestKind" NOT NULL,
    "childName" TEXT,
    "relationship" "GuardianRelationship",
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamJoinLink_token_key" ON "TeamJoinLink"("token");

-- CreateIndex
CREATE INDEX "TeamJoinLink_teamId_idx" ON "TeamJoinLink"("teamId");

-- CreateIndex
CREATE INDEX "TeamJoinRequest_teamId_status_idx" ON "TeamJoinRequest"("teamId", "status");

-- CreateIndex
CREATE INDEX "TeamJoinRequest_requesterId_idx" ON "TeamJoinRequest"("requesterId");

-- CreateIndex
CREATE INDEX "TeamJoinRequest_linkId_idx" ON "TeamJoinRequest"("linkId");

-- AddForeignKey
ALTER TABLE "TeamJoinLink" ADD CONSTRAINT "TeamJoinLink_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamJoinLink" ADD CONSTRAINT "TeamJoinLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamJoinRequest" ADD CONSTRAINT "TeamJoinRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamJoinRequest" ADD CONSTRAINT "TeamJoinRequest_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TeamJoinLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamJoinRequest" ADD CONSTRAINT "TeamJoinRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
