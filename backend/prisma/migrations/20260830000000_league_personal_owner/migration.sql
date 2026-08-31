-- #442 self-serve team creation.
--
-- A coach with no league gets an auto-provisioned personal container on their
-- first team create. `personalOwnerId` marks it and is UNIQUE, so a user can
-- own at most one, which is also the constraint the find-or-create in
-- TeamService.createTeam relies on.
--
-- ON DELETE SET NULL, not CASCADE: deleting a user must never cascade through
-- League -> Season -> Team -> Game. A cleared owner simply stops being a
-- personal league.
ALTER TABLE "League" ADD COLUMN "personalOwnerId" TEXT;

CREATE UNIQUE INDEX "League_personalOwnerId_key" ON "League"("personalOwnerId");

ALTER TABLE "League" ADD CONSTRAINT "League_personalOwnerId_fkey"
  FOREIGN KEY ("personalOwnerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
