-- Staff invitations by email (#460): a head coach invites an address to a
-- staff role. No User row is created at invite time (the claim-by-email hazard
-- in WorkOSService.syncUser); the account and the TeamStaff row are created on
-- accept. Mirrors TeamInvitation / GuardianInvitation, including the
-- hand-written PARTIAL unique index Prisma cannot express (one PENDING
-- invitation per team/address; any number of other rows may accumulate).
-- A new, empty table: no backfill.

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "invitedEmail" TEXT NOT NULL,
    "recipientHash" TEXT NOT NULL,
    "roleType" "TeamRoleType" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffInvitation_token_key" ON "StaffInvitation"("token");

-- CreateIndex
CREATE INDEX "StaffInvitation_teamId_invitedEmail_idx" ON "StaffInvitation"("teamId", "invitedEmail");

-- CreateIndex
CREATE INDEX "StaffInvitation_teamId_recipientHash_idx" ON "StaffInvitation"("teamId", "recipientHash");

-- CreateIndex
CREATE INDEX "StaffInvitation_invitedEmail_idx" ON "StaffInvitation"("invitedEmail");

-- CreateIndex
CREATE INDEX "StaffInvitation_status_idx" ON "StaffInvitation"("status");

-- CreateIndex
CREATE INDEX "StaffInvitation_expiresAt_idx" ON "StaffInvitation"("expiresAt");

-- CreateIndex (partial unique: only one PENDING invitation per team/address)
CREATE UNIQUE INDEX "StaffInvitation_pending_teamId_invitedEmail_key"
  ON "StaffInvitation"("teamId", "invitedEmail")
  WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
