-- SES bounce/complaint state per address (#449). Additive and nullable, so it
-- is safe on a populated table (no backfill): every existing row starts as
-- "no delivery problem known".
CREATE TYPE "EmailSuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT');

ALTER TABLE "User" ADD COLUMN "emailSuppressedAt" TIMESTAMP(3),
ADD COLUMN "emailSuppressedReason" "EmailSuppressionReason";
