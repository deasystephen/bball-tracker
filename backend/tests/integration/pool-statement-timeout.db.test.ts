/**
 * Real-database proof of the statement bounds `models/pool-config.ts` puts on
 * every pooled connection (#1036): `statement_timeout` and
 * `idle_in_transaction_session_timeout`.
 *
 * The production pool is checked for the settings it carries. The cancels are
 * proven on a second pool built the way `src/models/index.ts` builds the
 * production one (`PrismaPg` with `buildDbPoolOptions`), with short limits
 * injected and `max: 1`, so "the pool client is returned" is observable: the
 * next query on that one-client pool answers at once.
 *
 * TCP keepalive, the bound for a server that never answers, needs a dead peer
 * and is pinned in `tests/models-pool.test.ts` only. Rows carry the run id and
 * are removed in afterAll.
 */
jest.unmock('../../src/models');

import type { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import prisma from '../../src/models';
import {
  DB_CONNECTION_TIMEOUT_MS,
  buildDbPoolOptions,
  classifyDbError,
  dbPoolOptionsFromEnv,
  type DbTimeouts,
} from '../../src/models/pool-config';
import { logger } from '../../src/utils/logger';
import { respondWithError } from '../../src/utils/respond-with-error';
import { DbFixtures } from '../support/db-fixtures';
import { pause } from '../support/db-locks';

jest.setTimeout(60_000);

const fx = new DbFixtures(prisma, 'StmtTimeout');
const STATEMENT_CANCELLED = '57014';

/** A one-client pool built like production's, with the given limits. */
function shortPool(
  timeouts: Partial<DbTimeouts>,
  applicationName: string,
  connectionString = process.env.DATABASE_URL!
): PrismaClient {
  const options = buildDbPoolOptions({
    statementTimeoutMs: 300,
    lockTimeoutMs: 10_000,
    idleInTransactionTimeoutMs: 60_000,
    ...timeouts,
  });
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...options, max: 1, application_name: applicationName }),
  });
}

/** The SQLSTATE Prisma 7 carries for a driver error (P2010 raw, P2039 ORM). */
function sqlState(err: unknown): unknown {
  return (err as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } }).meta?.driverAdapterError?.cause
    ?.code;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

/** Backends of `applicationName` that are still running a statement. */
async function activeBackends(applicationName: string): Promise<number> {
  const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE application_name = ${applicationName} AND state = 'active'`;
  return n;
}

async function nameOf(userId: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  return row.name;
}

async function pidOf(tx: Pick<PrismaClient, '$queryRaw'>): Promise<number> {
  const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return pid;
}

const clients: PrismaClient[] = [];
function track(client: PrismaClient): PrismaClient {
  clients.push(client);
  return client;
}

beforeAll(async () => {
  await fx.requireDatabase();
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  await fx.cleanup();
});

describe('statement bounds on the production pool (#1036)', () => {
  const settingOf = async (name: string): Promise<string> => {
    const [{ setting }] = await prisma.$queryRaw<
      { setting: string }[]
    >`SELECT setting FROM pg_settings WHERE name = ${name}`;
    return setting;
  };

  // What this process configured (DB_STATEMENT_TIMEOUT_MS may override the default).
  const expected = dbPoolOptionsFromEnv();

  it('carries statement_timeout and idle_in_transaction_session_timeout', async () => {
    expect(await settingOf('statement_timeout')).toBe(String(expected.statement_timeout));
    expect(await settingOf('idle_in_transaction_session_timeout')).toBe(
      String(expected.idle_in_transaction_session_timeout)
    );
  });

  it('carries them inside an interactive transaction', async () => {
    const value = await prisma.$transaction(async (tx) => {
      const [{ setting }] = await tx.$queryRaw<
        { setting: string }[]
      >`SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`;
      return setting;
    });
    expect(value).toBe(String(expected.statement_timeout));
  });
});

describe('a statement past statement_timeout (#1036)', () => {
  it('is cancelled by PostgreSQL, and the pool answers the next query at once', async () => {
    const app = `stmt-cancel-${fx.run}`;
    const db = track(shortPool({}, app));
    const started = Date.now();
    const err = await rejectionOf(db.$queryRaw`SELECT pg_sleep(10)`);
    // Far under the 10 s sleep (the first connect is in here too).
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sqlState(err)).toBe(STATEMENT_CANCELLED);
    // Cancelled server-side: nothing of that pool is still running.
    expect(await activeBackends(app)).toBe(0);
    // The pool's one slot is free again (pg-pool discards a client whose query
    // failed outside a transaction, so this opens a new connection): it answers
    // well inside the pool wait instead of timing out on a held slot.
    const next = Date.now();
    await expect(db.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
    expect(Date.now() - next).toBeLessThan(DB_CONNECTION_TIMEOUT_MS);
  });

  it('rolls an interactive transaction back cleanly and leaves its connection usable', async () => {
    const userId = await fx.user('rollback', 'PLAYER');
    const before = await nameOf(userId);
    const db = track(shortPool({}, `stmt-tx-${fx.run}`));
    let cancelledOn: number | undefined;
    const err = await rejectionOf(
      db.$transaction(async (tx) => {
        cancelledOn = await pidOf(tx);
        await tx.user.update({ where: { id: userId }, data: { name: `changed-${fx.run}` } });
        await tx.$queryRaw`SELECT pg_sleep(10)`;
      })
    );
    expect(sqlState(err)).toBe(STATEMENT_CANCELLED);
    expect(await nameOf(userId)).toBe(before);
    // The same backend serves the next transaction: the server-side cancel left
    // the connection healthy, and the adapter returned it to the pool.
    await expect(db.$transaction(async (tx) => pidOf(tx))).resolves.toBe(cancelledOn);
  });

  it('is answered 500 with the route fallback body, not a retryable 503 and no SQL', async () => {
    const db = track(shortPool({}, `stmt-route-${fx.run}`));
    const err = await rejectionOf(db.$queryRaw`SELECT pg_sleep(10)`);
    expect(classifyDbError(err)).toBeUndefined();
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const res = { headersSent: false, statusCode: 200, status: jest.fn(), json: jest.fn(), set: jest.fn(), end: jest.fn() };
    res.status.mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    respondWithError(res as unknown as Response, err, { log: 'Error in test route', fallback: 'Failed to load' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to load' });
    expect(res.set).not.toHaveBeenCalled();
    // Logged at error, the 5xx level; the SQLSTATE stays in the log line.
    expect(logged).toHaveBeenCalledWith('Error in test route', expect.objectContaining({ status: 500 }));
    logged.mockRestore();
  });
});

describe('a lock wait (#1036)', () => {
  // The holder keeps the row locked on the production pool while the waiter,
  // whose lock_timeout is raised above its statement_timeout (as the finalize
  // transaction raises its own with SET LOCAL), waits behind it.
  it('is cut by statement_timeout even where lock_timeout is raised, rolling back the waiter', async () => {
    const held = await fx.user('held', 'PLAYER');
    const touched = await fx.user('touched', 'PLAYER');
    const before = await nameOf(touched);
    const db = track(shortPool({ statementTimeoutMs: 500, lockTimeoutMs: 10_000 }, `stmt-lock-${fx.run}`));

    let waiterError: unknown;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT id FROM "User" WHERE id = ${held} FOR UPDATE`;
        waiterError = await rejectionOf(
          db.$transaction(async (tx) => {
            await tx.user.update({ where: { id: touched }, data: { name: `changed-${fx.run}` } });
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${held} FOR UPDATE`;
          })
        );
      },
      { timeout: 10_000 }
    );

    expect(sqlState(waiterError)).toBe(STATEMENT_CANCELLED);
    expect(await nameOf(touched)).toBe(before);
    await expect(db.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
  });

  it('ends a holder idle in its transaction, releasing its locks', async () => {
    const held = await fx.user('idle-holder', 'PLAYER');
    const db = track(shortPool({ idleInTransactionTimeoutMs: 500 }, `stmt-idle-${fx.run}`));

    // A holder that takes the lock and then stalls, as a wedged API would. It
    // stalls far longer than the idle limit, so the probe below has room.
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    let stalled = true;
    const holder = rejectionOf(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${held} FOR UPDATE`;
          locked();
          await pause(8_000);
          stalled = false;
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 15_000 }
      )
    );
    await lockTaken;
    // Poll with NOWAIT until PostgreSQL has ended that session (no fixed sleep):
    // the row frees while the stalled holder is still inside its callback.
    let freed = false;
    for (const deadline = Date.now() + 6_000; !freed && Date.now() < deadline; ) {
      try {
        await prisma.$transaction(
          async (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${held} FOR UPDATE NOWAIT`
        );
        freed = true;
      } catch {
        await pause(100);
      }
    }
    expect(freed).toBe(true);
    expect(stalled).toBe(true);

    const err = await holder;
    expect(err).toBeInstanceOf(Error);
    // pg-pool dropped the ended client; the pool answers with a fresh one.
    await expect(db.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
  });
});
