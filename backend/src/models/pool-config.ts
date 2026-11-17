/**
 * Bounds for the node-postgres pool behind `@prisma/adapter-pg` (#751).
 *
 * Without `connectionTimeoutMillis`, pg waits forever for a free pool client
 * and for a new client's TCP/TLS connect (the OS TCP timeout, minutes on
 * Linux). `/health` pings through this pool and both health checks (the ECS
 * container check in `infra/task-definition.json` and the ALB target group)
 * give it 5 s, so an unreachable or saturated database must fail inside that
 * budget as a 503 with a cause, not a hang. A test keeps the timeout at least
 * 1 s under the container check's `timeout`.
 *
 * The matched messages are pg-pool's English literals; a test reads them out
 * of `pg-pool` in node_modules so a reworded message in a dependency
 * bump fails CI instead of silently turning every timeout into `db: 'down'`.
 *
 * The pool lives in this side-effect-free module so tests can read it while
 * `src/models` itself is mocked.
 */

/**
 * Per-task client ceiling (pg's implicit default, now explicit). A rolling
 * deploy briefly runs two tasks plus `prisma migrate deploy`, so the app's
 * peak is 2 x DB_POOL_MAX + 1 connections; the RDS alarm budget beside
 * `rds_max_connections_estimate` in `infra/alerting.tf` assumes this value.
 */
export const DB_POOL_MAX = 10;

/**
 * Bounds both the wait for a free pool client and a new client's connect.
 * Kept at least 1 s under the 5 s health-check timeout so the `/health` 503
 * (with its `db: 'timeout'` cause) reaches the checker before it gives up.
 */
export const DB_CONNECTION_TIMEOUT_MS = 3_500;

/**
 * `Retry-After` on the 503 the central error handler sends for a pool timeout.
 * The tradeoff of a bounded pool wait: a burst over DB_POOL_MAX now fails fast
 * with a retryable 503 instead of queueing until the ALB's 60 s idle timeout.
 */
export const DB_BUSY_RETRY_AFTER_SECONDS = 5;

/** Body of that 503, from the central error handler and from `respondWithError`. */
export const DB_BUSY_BODY = { error: 'Service temporarily unavailable, please retry' } as const;

/** How long an idle client stays open before the pool closes it. */
export const DB_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long any statement may wait for a row or table lock before PostgreSQL
 * cancels it (SQLSTATE 55P03, `classifyDbError` → the retryable 503
 * `transaction_timeout`). Set once, for every pooled connection, as the
 * `lock_timeout` startup option below (#944; #908 and #934 had set it per
 * transaction with `SET LOCAL`). Under Prisma's 5 s interactive-transaction
 * timeout so PostgreSQL gives up first and the connection is freed: Prisma's
 * timeout alone only stops Prisma waiting while the statement stays blocked
 * inside PostgreSQL, pinning the connection until the holder commits, and
 * every retry adds a waiter. The bound is per lock acquisition, not per
 * transaction: two slow holders in a row can still take a transaction past
 * 5 s (the same 503, from P2028), and even then the waiting statement is
 * cancelled at its own 4 s. A genuine race resolves in milliseconds, so
 * reaching it means the holder is stuck, a slow-database signal worth seeing.
 * `prisma migrate deploy` (the entrypoint) opens its own connection and is
 * unaffected; `prisma db seed` has its own client for its rows but finalizes
 * stats through `StatsService`, so those two calls run with this bound.
 * One transaction raises it for itself with `SET LOCAL`:
 * `StatsService.finalizeGameStats` (`FINALIZE_LOCK_TIMEOUT_MS`), whose wait
 * for the game row is meant to outlast a burst of event writes.
 */
export const DB_LOCK_TIMEOUT_MS = 4_000;

/**
 * How long any one statement may run, lock waits included, before PostgreSQL
 * cancels it (SQLSTATE 57014, #1036). Without it a statement that never
 * settles holds its pool client for as long as it hangs: the socket
 * revocation sweep (one query at a time) stops, enough of them exhaust the
 * pool, and a lock wait under a raised `lock_timeout` has no other limit.
 * PostgreSQL cancels server-side, so the connection answers the error and is
 * reusable (pg-pool still discards a client whose query failed outside a
 * transaction, as for any error).
 *
 * 30 s because it must sit above the slowest legitimate statement and below
 * what waits on it:
 * - above `StatsService`'s finalize transaction (15 s, its `SET LOCAL`
 *   lock_timeout 14 s): statement_timeout counts lock-wait time too, so a
 *   lower value would cancel that wait before its own bound;
 * - every other interactive transaction is cut by Prisma at 5 s, and every
 *   other statement (exports, account deletion, usage counts) is an indexed
 *   read or write measured in milliseconds;
 * - below the ALB's 60 s idle timeout, so a request still answers its own
 *   5xx, and below the sweep's 60 s stall report (`REVOCATION_SWEEP_STALL_MS`).
 *
 * `DB_STATEMENT_TIMEOUT_MS` in the environment overrides it, for an operator
 * script whose statement legitimately needs longer (`0` turns the statement
 * and query timeouts off for that process). Tests pin the order above.
 */
export const DB_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * How long a connection may sit inside an open transaction without running a
 * statement before PostgreSQL ends the session (SQLSTATE 25P03), releasing
 * every lock it holds. Prisma rolls its own transactions back at their
 * timeout (5 s, 15 s for finalize) while the API is alive, so this fires only
 * when the API side is gone or wedged mid-transaction, the stuck holder that
 * otherwise makes every `FOR UPDATE` behind it wait. pg-pool drops the ended
 * client (PrismaPg listens for its error, so nothing crashes).
 */
export const DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * pg's client-side `query_timeout`: how long the driver waits for any answer
 * before rejecting the query ("Query read timeout"). The server-side bounds
 * above need the server to answer; this is the backstop for when it never
 * does (a half-open connection after a Multi-AZ failover, where a query
 * written to a dead peer would otherwise wait out the kernel's TCP
 * retransmission, about 15 minutes on Linux). Five seconds over the statement
 * timeout, so a live server always answers first with its own 57014 and this
 * fires only on a dead connection. It does not cancel anything server-side.
 * Outside a transaction pg-pool destroys the client on the error; inside one,
 * Prisma's ROLLBACK queues behind the dead query and also times out, and the
 * client goes back to the pool until its socket errors or the next query on
 * it times out and destroys it (one more failed request at most).
 */
export const DB_QUERY_TIMEOUT_MARGIN_MS = 5_000;

/**
 * TCP keepalive on every pooled socket, first probe after 10 s of silence
 * (Node then probes every 1 s, 10 times). Detects a dead peer under an idle
 * pooled client or a query whose bytes the server acknowledged before it
 * vanished, so pg errors the client out instead of waiting on the kernel.
 */
export const DB_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

export interface DbTimeouts {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

export const DB_TIMEOUTS: DbTimeouts = {
  statementTimeoutMs: DB_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: DB_LOCK_TIMEOUT_MS,
  idleInTransactionTimeoutMs: DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
};

/**
 * The pg pool options for a set of timeouts. Production uses
 * `DB_POOL_OPTIONS`; the real-database suites build a pool with short values.
 * The three server settings go in the startup `options` string, the channel
 * `lock_timeout` has used in production over TLS since #944 (pg sends it in
 * the StartupMessage, after the TLS handshake). `0` means off in PostgreSQL
 * and in pg's `query_timeout` alike.
 */
export interface DbPoolOptions {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  keepAlive: true;
  keepAliveInitialDelayMillis: number;
  query_timeout: number;
  options: string;
}

export function buildDbPoolOptions(timeouts: DbTimeouts = DB_TIMEOUTS): DbPoolOptions {
  const { statementTimeoutMs, lockTimeoutMs, idleInTransactionTimeoutMs } = timeouts;
  return {
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: DB_KEEPALIVE_INITIAL_DELAY_MS,
    query_timeout: statementTimeoutMs > 0 ? statementTimeoutMs + DB_QUERY_TIMEOUT_MARGIN_MS : 0,
    /** pg passes this to the server as the connection's startup `options`. */
    options: [
      `-c lock_timeout=${lockTimeoutMs}`,
      `-c statement_timeout=${statementTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${idleInTransactionTimeoutMs}`,
    ].join(' '),
  };
}

/**
 * The statement timeout for this process: `DB_STATEMENT_TIMEOUT_MS` when set
 * (a non-negative integer, `0` = off), else the default. Anything else throws
 * at startup rather than silently running unbounded.
 */
export function statementTimeoutFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DB_STATEMENT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`DB_STATEMENT_TIMEOUT_MS must be a non-negative integer of milliseconds, got "${raw}"`);
  }
  return Number(raw.trim());
}

export const DB_POOL_OPTIONS = buildDbPoolOptions();

/**
 * The two messages pg-pool uses when `connectionTimeoutMillis` fires: its wait
 * for a free client, and its wrapper around a new client's connect timer
 * (pg's own `timeout expired`, kept as the `cause`).
 */
export const POOL_TIMEOUT_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
];

/** `err` and its `cause` chain, at most five deep (Prisma may wrap what pg threw). */
function* causeChain(err: unknown): Generator<unknown> {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    yield current;
    current = current instanceof Error ? current.cause : undefined;
  }
}

const messageOf = (candidate: unknown): string =>
  candidate instanceof Error ? candidate.message : String(candidate);

const matchesPoolTimeout = (candidate: unknown): boolean =>
  POOL_TIMEOUT_MESSAGES.some((m) => messageOf(candidate).includes(m));

/**
 * True when `err` (or any error in its `cause` chain, in case Prisma wraps it)
 * is one of pg's connect/pool timeouts: the pool is saturated or the database
 * is not answering TCP.
 */
export function isPoolTimeoutError(err: unknown): boolean {
  for (const candidate of causeChain(err)) {
    if (matchesPoolTimeout(candidate)) return true;
  }
  return false;
}

/** Prisma P2028 when an interactive transaction gets no connection within `maxWait`: pool saturation. */
export const TRANSACTION_START_MESSAGE = 'Unable to start a transaction in the given time';

/** Prisma P2028 message of an interactive transaction that outlived its timeout. */
export const TRANSACTION_EXPIRED_MESSAGE = 'The timeout for this transaction was';

/** PostgreSQL SQLSTATE for `lock_timeout` ("canceling statement due to lock timeout"). */
export const LOCK_TIMEOUT_SQLSTATE = '55P03';

export type DbErrorKind = 'lock_wait' | 'busy';

/** The pg driver adapter's SQLSTATE, which Prisma 7 puts on `meta` (P2010 for raw queries, P2039 for the ORM). */
function driverSqlState(candidate: unknown): unknown {
  const meta = (candidate as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } }).meta;
  return meta?.driverAdapterError?.cause?.code;
}

/**
 * Whether PostgreSQL itself cancelled the statement at `lock_timeout` (55P03),
 * anywhere in the cause chain. Narrower than `classifyDbError`, which answers
 * `lock_wait` for Prisma's own P2028 expiry too: the real-database suites use
 * this to prove the pool-wide `DB_LOCK_TIMEOUT_MS` fired, not Prisma's 5 s.
 */
export function isLockTimeoutError(err: unknown): boolean {
  for (const candidate of causeChain(err)) {
    if (driverSqlState(candidate) === LOCK_TIMEOUT_SQLSTATE) return true;
  }
  return false;
}

/**
 * Classify a database error that should be answered 503 with `Retry-After`
 * (#908), walking the cause chain once:
 *
 * - `lock_wait`: the transaction was cancelled waiting on a lock held by
 *   another request. Either Prisma `P2028` for an interactive transaction that
 *   outlived its timeout, or PostgreSQL's `lock_timeout` (55P03,
 *   `DB_LOCK_TIMEOUT_MS`), which Prisma wraps as P2010 or P2039 with the SQLSTATE
 *   on `meta.driverAdapterError.cause.code`.
 * - `busy`: a pg pool wait/connect timeout, or P2028 for `maxWait`
 *   exhaustion. Answered with `DB_BUSY_BODY`.
 *
 * A query on an already committed or rolled-back transaction is also P2028 but
 * is a bug and stays unclassified (500). Duck-typed so this module keeps no
 * Prisma import.
 */
export function classifyDbError(err: unknown): DbErrorKind | undefined {
  for (const candidate of causeChain(err)) {
    const message = messageOf(candidate);
    const isP2028 = (candidate as { code?: unknown }).code === 'P2028';
    if ((isP2028 && message.includes(TRANSACTION_EXPIRED_MESSAGE)) || driverSqlState(candidate) === LOCK_TIMEOUT_SQLSTATE) {
      return 'lock_wait';
    }
    if ((isP2028 && message.includes(TRANSACTION_START_MESSAGE)) || matchesPoolTimeout(candidate)) {
      return 'busy';
    }
  }
  return undefined;
}
