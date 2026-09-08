-- Account deletion (#444): anonymize-in-place tombstone marker. Additive and
-- nullable, so it is safe on a populated table (no backfill).
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
