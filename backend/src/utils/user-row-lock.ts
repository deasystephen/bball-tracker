/**
 * Row locks on `User` rows that serialise guardian primacy writes (#664).
 */

import { Prisma } from '@prisma/client';

/** A `User` row as read under the lock. A row that no longer exists is absent. */
export interface LockedUser {
  id: string;
  deletedAt: Date | null;
}

/**
 * `SELECT … FOR NO KEY UPDATE` on several `User` rows in ONE statement, in id
 * order, inside an interactive transaction.
 *
 * Every writer that decides `Guardian.isPrimary` for a child holds the child's
 * row while it does: accept (child and parent), `removeGuardian` (child) and
 * account deletion (the deleted user and all of their children, in its own
 * single statement with the same `ORDER BY "id"`). Locking every row a
 * transaction needs in one sorted statement is a global order, so two of these
 * writers can wait on each other but never deadlock, including two adults
 * each accepting to guard the other.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: it conflicts with itself and with
 * deletion's `FOR UPDATE`, which is all the serialisation needs, but not with
 * the `FOR KEY SHARE` a foreign-key insert takes, so a live game's `GameEvent`
 * rows or a new `TeamMember` naming the child never wait on an accept.
 *
 * Rows are re-read after any wait, so `deletedAt` is current; the caller
 * decides what a missing or tombstoned row means.
 */
export async function lockUsers(tx: Prisma.TransactionClient, ids: string[]): Promise<LockedUser[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return tx.$queryRaw<LockedUser[]>`
    SELECT "id", "deletedAt" FROM "User"
    WHERE "id" IN (${Prisma.join(unique)})
    ORDER BY "id"
    FOR NO KEY UPDATE`;
}

/**
 * `SELECT … FOR KEY SHARE` on several `User` rows in ONE statement, in id
 * order: the lock a foreign-key insert naming the row would take anyway,
 * taken EARLY, before the team row lock (#1087).
 *
 * The roster writes behind `lockTeamRow` insert rows that name a user (the
 * player of a new `TeamMember`, the coach of a new `TeamInvitation`). Left
 * to the insert, that key-share would come after the team lock, while
 * account deletion holds the user `FOR UPDATE` and then waits for the teams
 * the user heads: a deadlock. Taken first, the writer either waits for the
 * deletion holding nothing, or makes the deletion wait for it.
 *
 * `FOR KEY SHARE` and not `lockUsers`' `FOR NO KEY UPDATE`: it still blocks
 * deletion's `FOR UPDATE`, but not the plain column updates another
 * transaction makes to the row meanwhile (deleting a coach rewrites
 * `managedById` on the players they manage after locking their teams, which
 * a stronger lock here would deadlock with).
 */
export async function keyShareUsers(tx: Prisma.TransactionClient, ids: string[]): Promise<LockedUser[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return tx.$queryRaw<LockedUser[]>`
    SELECT "id", "deletedAt" FROM "User"
    WHERE "id" IN (${Prisma.join(unique)})
    ORDER BY "id"
    FOR KEY SHARE`;
}
