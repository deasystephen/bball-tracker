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
  DB_POOL_MAX,
  DB_POOL_OPTIONS,
  POOL_TIMEOUT_MESSAGES,
  dbBusyBody,
  isPoolTimeoutError,
  isTransactionTimeoutError,
  DB_BUSY_BODY,
  TRANSACTION_TIMEOUT_BODY,
} from '../src/models/pool-config';

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
    });
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

describe('isTransactionTimeoutError / dbBusyBody (#908)', () => {
  const p2028 = (message: string): Error =>
    Object.assign(new Error(message), { code: 'P2028' });
  const expired = p2028(
    'Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5003 ms passed since the start of the transaction.',
  );

  it('matches a P2028 for an expired interactive transaction, also behind a cause', () => {
    expect(isTransactionTimeoutError(expired)).toBe(true);
    expect(
      isTransactionTimeoutError(new Error('wrapper', { cause: expired })),
    ).toBe(true);
    expect(dbBusyBody(expired)).toBe(TRANSACTION_TIMEOUT_BODY);
  });

  it('answers maxWait exhaustion with the pool-busy body, not the lock-wait one', () => {
    const maxWait = p2028(
      'Transaction API error: Unable to start a transaction in the given time.',
    );
    expect(isTransactionTimeoutError(maxWait)).toBe(false);
    expect(dbBusyBody(maxWait)).toBe(DB_BUSY_BODY);
  });

  it('leaves a query on an already closed transaction, other codes and non-errors alone', () => {
    const closed = p2028(
      'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.',
    );
    expect(dbBusyBody(closed)).toBeUndefined();
    expect(
      isTransactionTimeoutError(
        Object.assign(new Error('The timeout for this transaction was 1 ms'), {
          code: 'P2002',
        }),
      ),
    ).toBe(false);
    expect(
      dbBusyBody(new Error('timeout exceeded when trying to connect')),
    ).toBe(DB_BUSY_BODY);
    expect(dbBusyBody(undefined)).toBeUndefined();
  });
});
