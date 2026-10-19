/**
 * Bound how long a transaction waits on another transaction's lock (#908).
 *
 * Prisma's interactive-transaction `timeout` (5 s) only stops Prisma waiting:
 * the statement stays blocked inside PostgreSQL, pinning a pool connection
 * until the lock holder commits, and every "please retry" adds another waiter.
 * `SET LOCAL lock_timeout` makes PostgreSQL cancel the waiting statement
 * itself (SQLSTATE 55P03, "canceling statement due to lock timeout"), which
 * frees the connection. `classifyDbError` maps that error to the same
 * retryable 503 `transaction_timeout` as a Prisma P2028.
 */

import type { Prisma } from '@prisma/client';

/**
 * The lock wait of the two supersede-resend transactions. Below Prisma's 5 s
 * transaction timeout so PostgreSQL gives up first and the connection is freed,
 * with a second for the reads that precede the first lock. A genuine
 * double-tap resolves in milliseconds, so reaching this means the holder is
 * stuck, a slow-database signal worth seeing.
 */
export const SUPERSEDE_LOCK_TIMEOUT_MS = 4000;

/**
 * The lock wait of the transactions that take the `Team` row lock
 * (`utils/team-row-lock.ts`: `TeamService.removeStaffMember`,
 * `TeamService.changeStaffRole`, `AccountService.deleteAccount`, #934). Same
 * reasoning and value as the supersede paths. Set as the transaction's first
 * statement, so it also bounds the `User` row locks deletion takes first.
 *
 * `lock_timeout` applies to EACH lock acquisition, not to the transaction:
 * a transaction that waits on two locks in a row (deletion: a User row, then
 * a Team row) can still reach Prisma's 5 s and answer the P2028 flavour of the
 * same 503. Even then no connection stays pinned past the bound: the
 * statement that is waiting is cancelled at its own 4 s, which is when the
 * rollback Prisma queued behind it can run.
 */
export const TEAM_LOCK_TIMEOUT_MS = 4000;

/**
 * `SET LOCAL lock_timeout` for the rest of the transaction, as `set_config(…,
 * true)` because `SET` cannot take a bind parameter. Run it as the
 * transaction's first statement.
 */
export async function setLocalLockTimeout(tx: Prisma.TransactionClient, ms: number): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`;
}
