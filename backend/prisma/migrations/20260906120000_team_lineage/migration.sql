-- Team lineage + per-season attributes (#462, docs/plans/team-lineage-and-competition.md).
--
-- HAND-WRITTEN. `prisma migrate dev` would emit `ADD COLUMN "lineageId" TEXT NOT NULL`,
-- which fails on a populated "Team" table and crash-loops the API at container start
-- (docker/entrypoint.sh runs `migrate deploy`). Order matters: enum before the column
-- that uses it, column nullable first, backfill, then NOT NULL + FK + unique index.

-- CreateEnum
CREATE TYPE "TeamGender" AS ENUM ('BOYS', 'GIRLS', 'COED');

-- CreateTable
CREATE TABLE "TeamLineage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamLineage_pkey" PRIMARY KEY ("id")
);

-- AlterTable: new columns, lineageId nullable for the backfill
ALTER TABLE "Team" ADD COLUMN "lineageId" TEXT,
                   ADD COLUMN "ageGroup" TEXT,
                   ADD COLUMN "gender" "TeamGender";

-- Backfill: one lineage per existing team-season. Assign the id on the team
-- first, then materialise the lineage rows from those ids, so no pairing step
-- can mis-assign. gen_random_uuid() is built into PostgreSQL 13+.
UPDATE "Team" SET "lineageId" = gen_random_uuid()::text WHERE "lineageId" IS NULL;
INSERT INTO "TeamLineage" ("id", "createdAt", "updatedAt")
    SELECT "lineageId", "createdAt", CURRENT_TIMESTAMP FROM "Team";

-- Now required
ALTER TABLE "Team" ALTER COLUMN "lineageId" SET NOT NULL;

-- AddForeignKey (Restrict: a lineage goes only after its last team-season)
ALTER TABLE "Team" ADD CONSTRAINT "Team_lineageId_fkey"
    FOREIGN KEY ("lineageId") REFERENCES "TeamLineage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "Team_lineageId_seasonId_key" ON "Team"("lineageId", "seasonId");
CREATE INDEX "Team_lineageId_idx" ON "Team"("lineageId");
