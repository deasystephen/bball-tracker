-- AlterTable: track the last (re-)registration time so a push token bound to a
-- different account can only be rebound once the old binding is stale (24h).
ALTER TABLE "PushToken" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
