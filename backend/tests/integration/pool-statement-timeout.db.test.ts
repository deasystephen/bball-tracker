/**
 * Real-database proof of the statement bounds `models/pool-config.ts` puts on
 * every pooled connection (#1036): `statement_timeout`,
 * `idle_in_transaction_session_timeout` and pg's client-side `query_timeout`.
 *
 * The production pool is checked for the settings it carries. The cancels are
 * proven on a second pool built the way `src/models/index.ts` builds the
 * production one (`PrismaPg` with `buildDbPoolOptions`), with short limits
 * injected and `max: 1`, so "the pool client is returned" is observable: the
 * next query on that one-client pool answers at once.
 *
 * The half-open case runs through an in-process TCP proxy that stops
 * forwarding (and stops passing on the server's close) without closing the
 * client's socket: the server never answers, as after a failover to a dead
 * peer. Rows carry the run id and are removed in afterAll.
 */
jest.unmock('../../src/models');

import net from 'node:net';
import type { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import prisma from '../../src/models';
import {
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DB_QUERY_TIMEOUT_MARGIN_MS,
  DB_STATEMENT_TIMEOUT_MS,
  buildDbPoolOptions,
  classifyDbError,
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

  it('carries statement_timeout and idle_in_transaction_session_timeout', async () => {
    expect(await settingOf('statement_timeout')).toBe(String(DB_STATEMENT_TIMEOUT_MS));
    expect(await settingOf('idle_in_transaction_session_timeout')).toBe(String(DB_IDLE_IN_TRANSACTION_TIMEOUT_MS));
  });

  it('carries them inside an interactive transaction', async () => {
    const value = await prisma.$transaction(async (tx) => {
      const [{ setting }] = await tx.$queryRaw<
        { setting: string }[]
      >`SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`;
      return setting;
    });
    expect(value).toBe(String(DB_STATEMENT_TIMEOUT_MS));
  });
});

describe('a statement past statement_timeout (#1036)', () => {
  it('is cancelled by PostgreSQL and its pool client is returned', async () => {
    const app = `stmt-cancel-${fx.run}`;
    const db = track(shortPool({}, app));
    const started = Date.now();
    const err = await rejectionOf(db.$queryRaw`SELECT pg_sleep(10)`);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sqlState(err)).toBe(STATEMENT_CANCELLED);
    // Cancelled server-side: nothing of that pool is still running.
    expect(await activeBackends(app)).toBe(0);
    // The only client of the pool is free again: the next query answers at once.
    const next = Date.now();
    await expect(db.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
    expect(Date.now() - next).toBeLessThan(1_000);
  });

  it('rolls an interactive transaction back cleanly', async () => {
    const userId = await fx.user('rollback', 'PLAYER');
    const before = await nameOf(userId);
    const db = track(shortPool({}, `stmt-tx-${fx.run}`));
    const err = await rejectionOf(
      db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { name: `changed-${fx.run}` } });
        await tx.$queryRaw`SELECT pg_sleep(10)`;
      })
    );
    expect(sqlState(err)).toBe(STATEMENT_CANCELLED);
    expect(await nameOf(userId)).toBe(before);
    await expect(db.$transaction(async (tx) => tx.$queryRaw`SELECT 1 AS ok`)).resolves.toEqual([{ ok: 1 }]);
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

    // A holder that takes the lock and then stalls, as a wedged API would.
    const holder = rejectionOf(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${held} FOR UPDATE`;
          await pause(2_000);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 10_000 }
      )
    );
    await pause(1_200);
    // Past the idle limit PostgreSQL has ended that session: the row is free
    // while the stalled holder is still inside its callback.
    const locked = await prisma.$transaction(
      async (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${held} FOR UPDATE NOWAIT`
    );
    expect(locked).toEqual([{ id: held }]);

    const err = await holder;
    expect(err).toBeInstanceOf(Error);
    // pg-pool dropped the ended client; the pool answers with a fresh one.
    await expect(db.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
  });
});

describe('a connection whose server never answers (#1036)', () => {
  let proxy: net.Server;
  let blackhole = false;
  const sockets: net.Socket[] = [];
  let proxiedUrl: string;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    proxy = net.createServer((client) => {
      const server = net.connect(Number(target.port || 5432), target.hostname);
      sockets.push(client, server);
      client.on('data', (chunk) => {
        if (!blackhole) server.write(chunk);
      });
      server.on('data', (chunk) => {
        if (!blackhole) client.write(chunk);
      });
      client.on('error', () => undefined);
      server.on('error', () => undefined);
      client.on('close', () => server.destroy());
      // A dead peer sends no FIN either.
      server.on('close', () => {
        if (!blackhole) client.destroy();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxied = new URL(target.toString());
    proxied.host = `127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    proxiedUrl = proxied.toString();
  });

  afterEach(() => {
    blackhole = false;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it('is rejected at query_timeout and its client replaced', async () => {
    const statementTimeoutMs = 300;
    const db = track(shortPool({ statementTimeoutMs }, `stmt-halfopen-${fx.run}`, proxiedUrl));
    await db.$queryRaw`SELECT 1`;
    blackhole = true;
    const started = Date.now();
    const err = await rejectionOf(db.$queryRaw`SELECT 1`);
    const waited = Date.now() - started;
    expect((err as Error).message).toContain('Query read timeout');
    expect(waited).toBeGreaterThanOrEqual(statementTimeoutMs + DB_QUERY_TIMEOUT_MARGIN_MS - 50);
    expect(waited).toBeLessThan(statementTimeoutMs + DB_QUERY_TIMEOUT_MARGIN_MS + 2_000);
    expect(classifyDbError(err)).toBeUndefined();
    blackhole = false;
    // Outside a transaction pg-pool destroys the client on the error, so the
    // next query opens a new connection instead of queueing behind the dead one.
    const next = Date.now();
    await expect(db.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
    expect(Date.now() - next).toBeLessThan(1_000);
  });
});
