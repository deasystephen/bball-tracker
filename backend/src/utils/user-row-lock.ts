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
