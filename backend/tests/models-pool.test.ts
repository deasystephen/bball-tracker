/**
 * The pg pool bounds (#751). `connectionTimeoutMillis` must fit inside the
 * container health check's timeout so an unreachable or saturated database
 * answers /health with a 503 instead of hanging past the check.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import {
  DB_CONNECTION_TIMEOUT_MS,
  DB_IDLE_TIMEOUT_MS,
  DB_LOCK_TIMEOUT_MS,
  DB_POOL_MAX,
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DB_KEEPALIVE_INITIAL_DELAY_MS,
  DB_STATEMENT_TIMEOUT_MAX_MS,
  DB_STATEMENT_TIMEOUT_MIN_MS,
  DB_STATEMENT_TIMEOUT_MS,
  POOL_TIMEOUT_MESSAGES,
  TRANSACTION_EXPIRED_MESSAGE,
  TRANSACTION_START_MESSAGE,
  classifyDbError,
  dbPoolOptionsFromEnv,
  isLockTimeoutError,
  isPoolTimeoutError,
  buildDbPoolOptions,
  statementTimeoutFromEnv,
} from '../src/models/pool-config';
import { FINALIZE_LOCK_TIMEOUT_MS, FINALIZE_TRANSACTION_TIMEOUT_MS } from '../src/services/stats-service';
import { REVOCATION_SWEEP_STALL_MS } from '../src/websocket/revocation';
import { deadlockDetected, lockTimeout, serializationFailure, transactionClosed } from './factories';

const TASK_DEFINITION = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../infra/task-definition.json'), 'utf8')
) as { containerDefinitions: Array<{ healthCheck?: { timeout?: number } }> };

const DEFAULTS = dbPoolOptionsFromEnv({});

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
    expect(DEFAULTS).toEqual({
      max: DB_POOL_MAX,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: DB_KEEPALIVE_INITIAL_DELAY_MS,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      lock_timeout: DB_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
  });

  it('bounds every lock wait pool-wide, under Prisma\'s 5 s transaction timeout (#944)', () => {
    expect(DB_LOCK_TIMEOUT_MS).toBeLessThan(5000);
    expect(DEFAULTS.lock_timeout).toBe(DB_LOCK_TIMEOUT_MS);
  });

  describe('statement bounds (#1036)', () => {
    it('sits above the slowest legitimate statement: the finalize transaction and its lock wait', () => {
      // statement_timeout counts lock-wait time, so it must not pre-empt the
      // finalize transaction's own SET LOCAL lock_timeout, nor the pool-wide one.
      // The default and the lowest override both clear the whole finalize transaction.
      for (const bound of [DB_STATEMENT_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_MIN_MS]) {
        expect(bound).toBeGreaterThan(FINALIZE_LOCK_TIMEOUT_MS);
        expect(bound).toBeGreaterThan(FINALIZE_TRANSACTION_TIMEOUT_MS);
        expect(bound).toBeGreaterThan(DB_LOCK_TIMEOUT_MS);
      }
      // Prisma closes its own transactions (15 s at most) before the server would.
      expect(DB_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(FINALIZE_TRANSACTION_TIMEOUT_MS);
    });

    const infraTf = (file: string): string => readFileSync(path.resolve(__dirname, '../../infra', file), 'utf8');

    it('ends one statement, pool wait included, inside the ALB idle timeout and the sweep stall report', () => {
      // The ALB keeps AWS's default 60 s idle timeout only while no Terraform file sets one.
      const infraDir = path.resolve(__dirname, '../../infra');
      for (const file of readdirSync(infraDir).filter((f) => f.endsWith('.tf'))) {
        expect({ file, setsIdleTimeout: /^\s*idle_timeout\s*=/m.test(infraTf(file)) }).toEqual({
          file,
          setsIdleTimeout: false,
        });
      }
      const ALB_IDLE_TIMEOUT_MS = 60_000;
      const worst = DB_CONNECTION_TIMEOUT_MS + DEFAULTS.statement_timeout;
      expect(worst).toBeLessThan(ALB_IDLE_TIMEOUT_MS);
      expect(worst).toBeLessThan(REVOCATION_SWEEP_STALL_MS);
    });

    // pg lets a same-named query parameter in the connection string win over
    // the pool's keys, so `?statement_timeout=0` would silently lift the bound.
    it('keeps the production DATABASE_URL free of a parameter that would replace a bound', () => {
      const url = infraTf('ecs.tf').match(/secret_string\s*=\s*"(postgresql:\/\/[^"]*)"/);
      expect(url).not.toBeNull();
      expect(url![1]).not.toMatch(/[?&](statement_timeout|lock_timeout|idle_in_transaction_session_timeout)=/);
    });

    it('turns on TCP keepalive, the only bound for a server that never answers', () => {
      expect(DEFAULTS.keepAlive).toBe(true);
      // Detection (first probe + Node's 10 probes 1 s apart) well inside the stall report.
      expect(DB_KEEPALIVE_INITIAL_DELAY_MS + 10_000).toBeLessThan(REVOCATION_SWEEP_STALL_MS);
    });

    it('turns only the statement timeout off at 0, keeping the others', () => {
      const off = buildDbPoolOptions({
        statementTimeoutMs: 0,
        lockTimeoutMs: DB_LOCK_TIMEOUT_MS,
        idleInTransactionTimeoutMs: DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      });
      expect(off).toMatchObject({
        statement_timeout: 0,
        lock_timeout: DB_LOCK_TIMEOUT_MS,
        idle_in_transaction_session_timeout: DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      });
    });

    it('reads DB_STATEMENT_TIMEOUT_MS strictly, within its range', () => {
      expect(statementTimeoutFromEnv(undefined)).toBe(DB_STATEMENT_TIMEOUT_MS);
      expect(statementTimeoutFromEnv('')).toBe(DB_STATEMENT_TIMEOUT_MS);
      expect(statementTimeoutFromEnv('0')).toBe(0);
      expect(statementTimeoutFromEnv(' 600000 ')).toBe(600_000);
      expect(statementTimeoutFromEnv(String(DB_STATEMENT_TIMEOUT_MIN_MS))).toBe(DB_STATEMENT_TIMEOUT_MIN_MS);
      expect(statementTimeoutFromEnv(String(DB_STATEMENT_TIMEOUT_MAX_MS))).toBe(DB_STATEMENT_TIMEOUT_MAX_MS);
      const tooHigh = String(DB_STATEMENT_TIMEOUT_MAX_MS + 1);
      for (const bad of ['-1', '30s', '1.5', 'abc', '2000', String(DB_STATEMENT_TIMEOUT_MIN_MS - 1), tooHigh, '99999999999']) {
        expect(() => statementTimeoutFromEnv(bad)).toThrow('DB_STATEMENT_TIMEOUT_MS');
      }
      // Inside PostgreSQL's integer GUC range.
      expect(DB_STATEMENT_TIMEOUT_MAX_MS).toBeLessThan(2 ** 31 - 1);
    });

    // Key names are checked at compile time (`satisfies PoolConfig`), and the
    // real-database suite reads the settings back from the server.
  });

  const loadModels = (env: Record<string, string | undefined>): jest.Mock => {
    const ORIGINAL = { DATABASE_URL: process.env.DATABASE_URL, DB_STATEMENT_TIMEOUT_MS: process.env.DB_STATEMENT_TIMEOUT_MS };
    process.env.DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/bball_tracker';
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const PrismaPg = jest.fn();
    try {
      jest.isolateModules(() => {
        jest.doMock('@prisma/adapter-pg', () => ({ PrismaPg }));
        jest.doMock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
        jest.requireActual('../src/models');
      });
      return PrismaPg;
    } finally {
      for (const [key, value] of Object.entries(ORIGINAL)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.dontMock('@prisma/adapter-pg');
      jest.dontMock('@prisma/client');
    }
  };

  it('hands the bounds to PrismaPg', () => {
    expect(loadModels({})).toHaveBeenCalledWith(expect.objectContaining(DEFAULTS));
  });

  it('lets DB_STATEMENT_TIMEOUT_MS raise the statement bound for one process (#1036)', () => {
    const config = loadModels({ DB_STATEMENT_TIMEOUT_MS: '0' }).mock.calls[0][0] as Record<string, unknown>;
    expect(config).toMatchObject({ statement_timeout: 0, lock_timeout: DB_LOCK_TIMEOUT_MS });
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

  it('classifies a deadlock PostgreSQL broke (40P01) as lock_wait, and not as a lock timeout', () => {
    expect(classifyDbError(deadlockDetected('P2034'))).toBe('lock_wait');
    expect(classifyDbError(new Error('wrapper', { cause: deadlockDetected('P2010') }))).toBe('lock_wait');
    expect(isLockTimeoutError(deadlockDetected())).toBe(false);
    // P2034 is also a serialization failure, which is not a lock wait.
    expect(classifyDbError(serializationFailure())).toBeUndefined();
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
