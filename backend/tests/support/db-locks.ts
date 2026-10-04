/**
 * Helpers for real-database suites that test row locks (#765).
 *
 * The pattern: hold a row lock from the test in a `prisma.$transaction`, start
 * the call under test, then read Postgres's own lock tables from the holder to
 * prove the call is waiting on it, and at which statement. A fixed sleep cannot
 * tell "still waiting" from "not started yet"; these helpers can.
 *
 * Timeouts. A Prisma interactive transaction defaults to a 5 s `timeout`
 * (2 s `maxWait` for a connection) and the services pass none, so a blocked
 * call dies with P2028 once it has been inside its transaction for 5 s. Keep
 * the holder's whole callback, including `waitForBlockedBy`, well under that.
 */

import type { Prisma } from '@prisma/client';

/** The default `timeout` of a Prisma interactive transaction, in ms. */
export const PRISMA_TRANSACTION_TIMEOUT_MS = 5000;

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records when a promise settles, so a test can assert it has not yet. */
export function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  return { promise, settled: () => done };
}

/** The Postgres backend pid of the connection a transaction runs on. */
export async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
  const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return pid;
}

export interface BlockedBackend {
  /** Which of the `tables` asked about this backend already holds a lock on, sorted. */
  relations: string[];
}

/**
 * Waits until at least one backend is blocked by `holderPid`, then returns
 * each blocked backend with the tables (from `tables`) it holds locks on.
 * A backend that waits before its first write holds none.
 *
 * Throws when nothing is blocked within `timeoutMs`, naming the likely causes,
 * so a slow run does not read like a lock that is missing.
 */
export async function waitForBlockedBy(
  tx: Prisma.TransactionClient,
  holderPid: number,
  { tables = [], timeoutMs = 2000 }: { tables?: string[]; timeoutMs?: number } = {}
): Promise<BlockedBackend[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await tx.$queryRaw<BlockedBackend[]>`
      SELECT array(
               SELECT DISTINCT c.relname::text FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
               WHERE l.pid = a.pid AND l.granted AND c.relname = ANY(${tables}::text[])
               ORDER BY 1
             ) AS relations
      FROM pg_stat_activity a
      WHERE ${holderPid}::int = ANY(pg_blocking_pids(a.pid))
    `;
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) {
      throw new Error(
        `No backend was blocked by pid ${holderPid} within ${timeoutMs} ms. Either the call under ` +
          'test takes no lock that conflicts with the holder, or it had not reached its lock ' +
          'statement yet (a slow run: raise timeoutMs, keeping the holder under ' +
          `${PRISMA_TRANSACTION_TIMEOUT_MS} ms).`
      );
    }
    await pause(25);
  }
}
