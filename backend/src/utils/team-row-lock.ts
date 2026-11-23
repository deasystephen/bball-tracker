/**
 * Row lock on a `Team` row that serialises head-coach changes (#463).
 */

import { Prisma } from '@prisma/client';
import { NotFoundError } from './errors';

/**
 * `SELECT … FOR NO KEY UPDATE` on the team's row inside an interactive
 * transaction.
 *
 * The last-head-coach guard (`lastHeadCoachTeams`) and the write that removes
 * or demotes a head coach are two statements. Without a lock, two concurrent
 * removals (or demotions) of a team's two head coaches each see the other
 * still holding HEAD_COACH, both pass, and the team is left with none. Every
 * such writer takes this lock first and runs the guard and the write behind
 * it, so the second one re-reads after the first committed:
 * `TeamService.removeStaffMember` and `TeamService.changeStaffRole` (one team,
 * `lockTeamRow`) and `AccountService.deleteAccount` (every team where the user
 * holds HEAD_COACH, `lockTeamRows`).
 *
 * Lock order: User before League before Team wherever several are taken, and
 * several Team rows only in one id-ordered statement (`lockTeamRows`). Account
 * deletion locks its User rows, then its teams; `addStaffMember` the target's
 * and requester's User rows, then the team (#1038); the staff invite and
 * accept the inviter's or account's User row, then the team;
 * `LeagueService.removeLeagueAdmin` the former admin's User row, the League,
 * then its affected teams (#1038); the season rollover Users, League, Team.
 * `removeStaffMember` and `changeStaffRole` take only Team. So no two of
 * them wait on each other in a cycle.
 *
 * The jersey-number rule (#1087, `utils/jersey-number.ts`) takes it too: Add
 * Player (case 2: the reused User, then a key-share on the acting coach, then
 * Team, then the invitation rows it expires), `addPlayer` (a key-share on the
 * player, then Team), a number change on `updateTeamMember` (Team only; it
 * writes no foreign key), and both invitation accepts (a key-share on the
 * player, then Team, BEFORE flipping the invitation row). Every User row a
 * later insert names is key-shared before Team (`user-row-lock.ts#keyShareUsers`),
 * because account deletion holds the deleted user FOR UPDATE while it waits
 * for the teams they head. Known residual: case 2's `FOR NO KEY UPDATE` on a
 * reused row (it updates that row) can still deadlock with the deletion of the
 * coach who manages it, which rewrites `managedById` after locking their
 * teams; PostgreSQL then aborts one side (40P01).
 *
 * Second known residual, the same shape (#1072): approving a CHILD join
 * request onto an existing record (`JoinLinkService.approveRequest` with
 * `playerId`) locks that managed record with the requester and approver
 * (`lockUsers`, `FOR NO KEY UPDATE`) and then waits for this team row. It is
 * the only writer that holds a managed player's row and then waits for a
 * team. Deleting the coach who manages that record (`deleteAccount`: the coach
 * FOR UPDATE, their head-coach teams, then `updateMany({ managedById })`, which
 * needs the record's row) can wait on it in a cycle. PostgreSQL's deadlock
 * detector aborts one side with 40P01, which `classifyDbError` does not map:
 * that side answers a 500, not the retryable 503. The approval without
 * `playerId` locks only the requester and the approver (logins, never a
 * managed record), so it is not part of this cycle. Not reordered: locking
 * the record after the team would cycle with a guardian accept by the same
 * parent for the same record (`lockUsers([child, parent])`, while the
 * approval holds the parent and the team), and no record lock at all loses
 * the per-child lock that keeps a child to one primary guardian.
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

/** `lockTeamRow`, answering 404 when the team was deleted after the caller's unlocked read. */
export async function lockTeamOrNotFound(tx: Prisma.TransactionClient, teamId: string): Promise<void> {
  if (!(await lockTeamRow(tx, teamId))) {
    throw new NotFoundError('Team not found');
  }
}

/**
 * `SELECT … FOR UPDATE` on one `TeamMember` row (#1072): a membership check
 * that stays true until the caller commits. `TeamService.removePlayer` takes
 * no User or Team lock, so a plain read of the row could be followed by a
 * removal committing before the caller's writes; behind this lock a removal
 * that committed first reads as no row, and one that comes second waits for
 * the caller. Taken after the team row lock (User → Team → TeamMember); no
 * writer of a `TeamMember` row takes a User or Team lock after touching it
 * (`removePlayer` deletes it and then practice answers; `updateTeamMember`
 * takes the team lock first for a number, and no lock for a position-only
 * edit), so this adds no cycle.
 *
 * Returns whether the row exists.
 */
export async function lockTeamMemberRow(
  tx: Prisma.TransactionClient,
  teamId: string,
  playerId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TeamMember" WHERE "teamId" = ${teamId} AND "playerId" = ${playerId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * `lockTeamRow` for several teams in ONE statement, in ascending id order, so
 * two transactions locking overlapping sets wait on each other but never
 * deadlock. Returns the ids that exist.
 */
export async function lockTeamRows(tx: Prisma.TransactionClient, teamIds: string[]): Promise<string[]> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) {
    return [];
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Team"
    WHERE "id" IN (${Prisma.join(unique)})
    ORDER BY "id"
    FOR NO KEY UPDATE`;
  return rows.map((row) => row.id);
}
