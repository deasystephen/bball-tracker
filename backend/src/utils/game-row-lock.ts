/**
 * Row lock that serializes every write deriving state from a game's event log.
 */

import type { GameStatus, Prisma } from '@prisma/client';
import { NotFoundError } from './errors';

/** The game row as read under the lock. */
export interface LockedGame {
  status: GameStatus;
  homeScore: number;
  awayScore: number;
}

/**
 * `SELECT … FOR UPDATE` on the game row inside an interactive transaction.
 *
 * Every writer that derives something from the event log takes this lock
 * **first**, before inserting or deleting an event: the score recompute in
 * `GameEventService` (#665), the `PATCH /games/:id { homeScore }` SHOT check
 * (#666) and stats finalization (#724). Taking it first matters: an event
 * insert holds a `KEY SHARE` lock on the game row through the foreign key, so
 * two transactions that insert and only then ask for `FOR UPDATE` deadlock.
 *
 * The returned row is current for the rest of the transaction: nobody else can
 * change the game's status or scores until it commits.
 */
export async function lockGameRow(
  tx: Prisma.TransactionClient,
  gameId: string
): Promise<LockedGame> {
  const rows = await tx.$queryRaw<LockedGame[]>`
    SELECT "status", "homeScore", "awayScore" FROM "Game" WHERE "id" = ${gameId} FOR UPDATE`;
  const row = rows[0];
  if (!row) {
    throw new NotFoundError('Game not found');
  }
  return row;
}
