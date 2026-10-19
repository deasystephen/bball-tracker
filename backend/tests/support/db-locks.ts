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
 * call dies with P2028 once it has been inside its transaction for 5 s. Two
 * clocks therefore matter: the HOLDER transaction's `timeout` must exceed the
 * `waitForBlockedBy` deadline plus the holder's remaining work (the default
 * deadline needs an explicit holder `timeout`, e.g. 10 s), and the holder must
 * release promptly once the call is seen waiting, because the call's own 5 s
 * (and its `lock_timeout`, where it sets one) are running by then.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { classifyDbError, isLockTimeoutError } from '../../src/models/pool-config';
import { dbBusyOutcome } from '../../src/utils/db-busy';

/** The default `timeout` of a Prisma interactive transaction, in ms. */
export const PRISMA_TRANSACTION_TIMEOUT_MS = 5000;

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Records when and how a promise settles, so a test can assert it has not yet
 * and `waitForBlockedBy` can say what happened when it did.
 */
export interface Tracked<T> {
  promise: Promise<T>;
  settled: () => boolean;
  /** 'fulfilled', or 'rejected: <message>' once settled; undefined before. */
  outcome: () => string | undefined;
}
export function track<T>(promise: Promise<T>): Tracked<T> {
  let outcome: string | undefined;
  promise.then(
    () => (outcome = 'fulfilled'),
    (err: unknown) => (outcome = `rejected: ${err instanceof Error ? err.message : String(err)}`)
  );
  return { promise, settled: () => outcome !== undefined, outcome: () => outcome };
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
 * so a slow run does not read like a lock that is missing. Pass the call under
 * test's `settled` (from `track`) and the wait also stops, with its own
 * message, as soon as that call finishes without ever having blocked: that is
 * a missing lock, not a slow run, and no deadline needs to pass to say so.
 *
 * The deadline bounds only how long the call under test may take to REACH its
 * lock statement (CI runs Jest with coverage on a loaded runner); once it is
 * blocked the caller proceeds at once. The #932 CI failures were not slowness
 * but a stale pg_stat_activity snapshot hiding a freshly opened pool backend;
 * every poll now clears the snapshot first.
 * Keep `timeoutMs` plus the holder's remaining work under the holder
 * transaction's `timeout`, and remember that the call under test's own
 * `lock_timeout`, where it sets one, starts only when it begins waiting.
 */
export async function waitForBlockedBy(
  tx: Prisma.TransactionClient,
  holderPid: number,
  {
    tables = [],
    timeoutMs = 8000,
    settled,
  }: { tables?: string[]; timeoutMs?: number; settled?: Pick<Tracked<unknown>, 'settled' | 'outcome'> } = {}
): Promise<BlockedBackend[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // pg_stat_activity is snapshotted once per transaction, and the holder
    // polls from inside one: a backend the pool opened AFTER the first read
    // (a cold pool on CI) is missing from the stale snapshot, so the waiter
    // is never seen even while it sits on the lock (#932). Drop the snapshot
    // before every read; pg_blocking_pids itself is live.
    await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
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
    if (settled?.settled()) {
      throw new Error(
        `The call under test settled (${settled.outcome()}) without ever being blocked by pid ` +
          `${holderPid}. If it fulfilled, it takes no lock that conflicts with the holder; if it ` +
          'rejected, read the reason before suspecting the lock (a loaded run can kill its own ' +
          'transaction first).'
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No backend was blocked by pid ${holderPid} within ${timeoutMs} ms. Either the call under ` +
          'test takes no lock that conflicts with the holder, or it had not reached its lock ' +
          'statement yet (a slow run: raise timeoutMs and give the holder transaction a `timeout` ' +
          'above it; pass the tracked call\'s `settled` so a call that finishes without blocking ' +
          'fails at once).'
      );
    }
    await pause(25);
  }
}

export interface LockWaitOutcome {
  /** What the call under test rejected with (or its fulfilled value). */
  err: unknown;
  /** From just before the call to its settling, while the holder kept the lock. */
  elapsedMs: number;
}

/**
 * Takes a lock from a holder transaction, runs `call` while the holder keeps
 * it, and reports how the call ended and how long it took. The holder stays
 * open for the whole call, so the call must give up on its own: this is the
 * pattern that proves a `SET LOCAL lock_timeout` (`src/utils/lock-timeout.ts`)
 * cancels a waiter, as opposed to the lock being released. `holdLock` runs
 * inside the holder and takes the lock (a `SELECT … FOR UPDATE` /
 * `FOR NO KEY UPDATE`). The holder's `timeout` must outlive the call's own
 * limits (its `lock_timeout`, then Prisma's 5 s).
 */
export async function callBehindLock(
  db: Pick<PrismaClient, '$transaction'>,
  holdLock: (holder: Prisma.TransactionClient) => Promise<void>,
  call: () => Promise<unknown>,
  { holderTimeoutMs = 15_000 }: { holderTimeoutMs?: number } = {}
): Promise<LockWaitOutcome> {
  let err: unknown;
  let elapsedMs = 0;
  await db.$transaction(
    async (holder) => {
      await holdLock(holder);
      const startedAt = Date.now();
      err = await call().catch((e: unknown) => e);
      elapsedMs = Date.now() - startedAt;
    },
    { timeout: holderTimeoutMs }
  );
  return { err, elapsedMs };
}

/**
 * Asserts a `callBehindLock` outcome is PostgreSQL's `lock_timeout` cancel
 * (55P03, not Prisma's own P2028 expiry, which classifies the same) after
 * about `lockTimeoutMs`, mapped to the retryable 503 `transaction_timeout`.
 * The service lets the database error through; the error handlers map it.
 * No upper bound on the elapsed time: a loaded runner adds pool and statement
 * time before the wait starts, and the SQLSTATE is what proves which timeout
 * fired.
 */
export function expectCancelledByLockTimeout({ err, elapsedMs }: LockWaitOutcome, lockTimeoutMs: number): void {
  expect(isLockTimeoutError(err)).toBe(true);
  expect(classifyDbError(err)).toBe('lock_wait');
  expect(dbBusyOutcome(err)?.body).toMatchObject({ code: 'transaction_timeout' });
  expect(elapsedMs).toBeGreaterThanOrEqual(lockTimeoutMs - 500);
}
