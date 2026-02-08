-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isManaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "managedById" TEXT;

-- AlterTable: Make email nullable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "User_managedById_idx" ON "User"("managedById");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managedById_fkey" FOREIGN KEY ("managedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
