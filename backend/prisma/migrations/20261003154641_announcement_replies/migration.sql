-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyOnReplies" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AnnouncementReply" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnnouncementReply_announcementId_createdAt_idx" ON "AnnouncementReply"("announcementId", "createdAt");

-- CreateIndex
CREATE INDEX "AnnouncementReply_authorId_idx" ON "AnnouncementReply"("authorId");

-- AddForeignKey
ALTER TABLE "AnnouncementReply" ADD CONSTRAINT "AnnouncementReply_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReply" ADD CONSTRAINT "AnnouncementReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
