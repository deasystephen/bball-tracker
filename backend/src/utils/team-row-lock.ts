/**
 * Row lock on a `Team` row that serialises head-coach changes (#463).
 */

import { Prisma } from '@prisma/client';

/**
 * `SELECT … FOR NO KEY UPDATE` on the team's row inside an interactive
 * transaction.
 *
 * The last-head-coach guard (`lastHeadCoachTeams`) and the write that removes
 * or demotes a head coach are two statements. Without a lock, two concurrent
 * removals (or demotions) of a team's two head coaches each see the other
 * still holding HEAD_COACH, both pass, and the team is left with none. Every
 * such writer (`TeamService.removeStaffMember`, `TeamService.changeStaffRole`)
 * takes this lock first and runs the guard and the write behind it, so the
 * second one re-reads after the first committed.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: it conflicts with itself, which is
 * all the serialisation needs, but not with the `FOR KEY SHARE` that every
 * foreign-key insert naming the team takes, so a game, roster or staff insert
 * on the team never waits on a staff change (same reasoning as
 * `utils/user-row-lock.ts`).
 *
 * Returns whether the row exists.
 */
export async function lockTeamRow(tx: Prisma.TransactionClient, teamId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR NO KEY UPDATE`;
  return rows.length > 0;
}
