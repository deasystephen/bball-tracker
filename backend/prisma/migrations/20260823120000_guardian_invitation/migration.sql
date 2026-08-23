-- PARENT (guardian) role, docs/plans/parent-role-spec.md: a coach invites an
-- adult to be the guardian of a (managed) player. Acceptance creates the
-- Guardian row. Mirrors TeamInvitation, including the hand-written PARTIAL
-- unique index that Prisma cannot express (only one PENDING invitation per
-- child/email; any number of ACCEPTED/CANCELLED/EXPIRED rows may accumulate).

-- CreateTable
CREATE TABLE "GuardianInvitation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "teamId" TEXT,
    "invitedEmail" TEXT NOT NULL,
    "relationship" "GuardianRelationship" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "GuardianInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuardianInvitation_token_key" ON "GuardianInvitation"("token");

-- CreateIndex
CREATE INDEX "GuardianInvitation_childId_invitedEmail_idx" ON "GuardianInvitation"("childId", "invitedEmail");

-- CreateIndex
CREATE INDEX "GuardianInvitation_invitedEmail_idx" ON "GuardianInvitation"("invitedEmail");

-- CreateIndex
CREATE INDEX "GuardianInvitation_status_idx" ON "GuardianInvitation"("status");

-- CreateIndex
CREATE INDEX "GuardianInvitation_expiresAt_idx" ON "GuardianInvitation"("expiresAt");

-- CreateIndex (partial unique — only one PENDING invitation per child/email)
CREATE UNIQUE INDEX "GuardianInvitation_pending_childId_invitedEmail_key"
  ON "GuardianInvitation"("childId", "invitedEmail")
  WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_childId_fkey" FOREIGN KEY ("childId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
