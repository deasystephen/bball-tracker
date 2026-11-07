-- #981: the age screen. NULL until the account holder answers the neutral
-- birth month/year question once; the answer itself is never stored, only
-- the moment it confirmed the holder is old enough. Existing rows stay NULL
-- (owner decision 2026-11-07: ask once on next launch, no backfill).
ALTER TABLE "User" ADD COLUMN "ageConfirmedAt" TIMESTAMP(3);
