/**
 * The pg pool bounds (#751). `connectionTimeoutMillis` must fit inside the
 * container health check's timeout so an unreachable or saturated database
 * answers /health with a 503 instead of hanging past the check.
 */
import { readFileSync } from 'fs';
import path from 'path';
import {
  DB_CONNECTION_TIMEOUT_MS,
  DB_IDLE_TIMEOUT_MS,
  DB_LOCK_TIMEOUT_MS,
  DB_POOL_MAX,
  DB_POOL_OPTIONS,
  POOL_TIMEOUT_MESSAGES,
  TRANSACTION_EXPIRED_MESSAGE,
  TRANSACTION_START_MESSAGE,
  classifyDbError,
  isLockTimeoutError,
  isPoolTimeoutError,
} from '../src/models/pool-config';
import { lockTimeout, transactionClosed } from './factories';

const TASK_DEFINITION = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../infra/task-definition.json'), 'utf8')
) as { containerDefinitions: Array<{ healthCheck?: { timeout?: number } }> };

describe('pg pool bounds', () => {
  it('sets a connect/pool timeout at least 1 s under the container health check timeout', () => {
    const timeouts = TASK_DEFINITION.containerDefinitions
      .map((c) => c.healthCheck?.timeout)
      .filter((t): t is number => typeof t === 'number');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(DB_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    for (const seconds of timeouts) {
      // Headroom so the 503 reaches the checker before the checker gives up.
      expect(DB_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(seconds * 1000 - 1000);
    }
  });

  it('keeps the per-task ceiling the RDS alarm budget assumes', () => {
    expect(DB_POOL_MAX).toBe(10);
    expect(DB_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(DB_POOL_OPTIONS).toEqual({
      max: DB_POOL_MAX,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      options: `-c lock_timeout=${DB_LOCK_TIMEOUT_MS}`,
    });
  });

  it('bounds every lock wait pool-wide, under Prisma\'s 5 s transaction timeout (#944)', () => {
    expect(DB_LOCK_TIMEOUT_MS).toBeLessThan(5000);
    expect(DB_POOL_OPTIONS.options).toBe(`-c lock_timeout=${DB_LOCK_TIMEOUT_MS}`);
  });

  it('hands the bounds to PrismaPg', () => {
    const ORIGINAL = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/bball_tracker';
    const PrismaPg = jest.fn();
    try {
      jest.isolateModules(() => {
        jest.doMock('@prisma/adapter-pg', () => ({ PrismaPg }));
        jest.doMock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
        jest.requireActual('../src/models');
      });
      expect(PrismaPg).toHaveBeenCalledWith(expect.objectContaining(DB_POOL_OPTIONS));
    } finally {
      process.env.DATABASE_URL = ORIGINAL;
      jest.dontMock('@prisma/adapter-pg');
      jest.dontMock('@prisma/client');
    }
  });
});

describe('isPoolTimeoutError', () => {
  // A reworded message in a pg-pool bump would silently turn every timeout into
  // db 'down'; read the literals from the installed source. Both live in
  // pg-pool: the second wraps pg's own client connect timer ('timeout expired').
  // Read by path: the package's `exports` map hides `pg-pool/index.js`.
  it('matches messages pg-pool still emits', () => {
    const sources = readFileSync(path.resolve(__dirname, '../node_modules/pg-pool/index.js'), 'utf8');
    expect(POOL_TIMEOUT_MESSAGES).toHaveLength(2);
    for (const message of POOL_TIMEOUT_MESSAGES) {
      expect(sources).toContain(message);
    }
  });

  it("recognises pg-pool's wait timeout and pg's connect timeout", () => {
    expect(isPoolTimeoutError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isPoolTimeoutError(new Error('Connection terminated due to connection timeout'))).toBe(true);
  });

  it('finds a timeout wrapped in a cause', () => {
    const inner = new Error('timeout exceeded when trying to connect');
    expect(isPoolTimeoutError(new Error('Invalid prisma.$queryRaw() invocation', { cause: inner }))).toBe(true);
  });

  it('treats everything else as not a timeout', () => {
    expect(isPoolTimeoutError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(false);
    expect(isPoolTimeoutError(new Error('no pg_hba.conf entry ... no encryption'))).toBe(false);
    expect(isPoolTimeoutError(undefined)).toBe(false);
  });
});

describe('classifyDbError (#908)', () => {
  const maxWait = transactionClosed('Transaction API error: Unable to start a transaction in the given time.');
  const closed = transactionClosed(
    'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.'
  );

  // The classification is a substring match on Prisma's English wording: read
  // both strings out of the installed client so a reworded message in a bump
  // fails CI instead of silently turning every lock wait into a 500.
  it('matches messages the installed Prisma client still emits', () => {
    const runtime = readFileSync(path.resolve(__dirname, '../node_modules/@prisma/client/runtime/client.js'), 'utf8');
    expect(runtime).toContain(TRANSACTION_EXPIRED_MESSAGE);
    expect(runtime).toContain(TRANSACTION_START_MESSAGE);
  });

  it('classifies an expired interactive transaction as lock_wait, also behind a cause', () => {
    expect(classifyDbError(transactionClosed())).toBe('lock_wait');
    expect(classifyDbError(new Error('wrapper', { cause: transactionClosed() }))).toBe('lock_wait');
  });

  it("classifies PostgreSQL's lock_timeout (55P03) behind P2039 or P2010 as lock_wait", () => {
    expect(classifyDbError(lockTimeout('P2039'))).toBe('lock_wait');
    expect(classifyDbError(lockTimeout('P2010'))).toBe('lock_wait');
  });

  it('isLockTimeoutError tells the PostgreSQL cancel from a Prisma expiry, also behind a cause (#934)', () => {
    expect(isLockTimeoutError(lockTimeout('P2039'))).toBe(true);
    expect(isLockTimeoutError(new Error('wrapper', { cause: lockTimeout('P2010') }))).toBe(true);
    expect(isLockTimeoutError(transactionClosed())).toBe(false);
    expect(isLockTimeoutError(new Error('plain'))).toBe(false);
  });

  it('classifies maxWait exhaustion and pool timeouts as busy', () => {
    expect(classifyDbError(maxWait)).toBe('busy');
    expect(classifyDbError(new Error('timeout exceeded when trying to connect'))).toBe('busy');
  });

  it('requires the P2028 code and leaves a query on a closed transaction alone', () => {
    expect(classifyDbError(closed)).toBeUndefined();
    expect(classifyDbError(new Error('The timeout for this transaction was 1 ms'))).toBeUndefined();
    expect(classifyDbError(new Error('Unable to start a transaction in the given time'))).toBeUndefined();
    expect(classifyDbError(undefined)).toBeUndefined();
  });
});
