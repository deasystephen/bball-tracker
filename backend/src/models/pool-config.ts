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

export const DB_POOL_OPTIONS = {
  max: DB_POOL_MAX,
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
} as const;

/**
 * The two messages pg-pool uses when `connectionTimeoutMillis` fires: its wait
 * for a free client, and its wrapper around a new client's connect timer
 * (pg's own `timeout expired`, kept as the `cause`).
 */
export const POOL_TIMEOUT_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
];

/**
 * True when `err` (or any error in its `cause` chain, in case Prisma wraps it)
 * is one of pg's connect/pool timeouts: the pool is saturated or the database
 * is not answering TCP.
 */
export function isPoolTimeoutError(err: unknown): boolean {
  return findInCauseChain(err, (candidate) => {
    const message = candidate instanceof Error ? candidate.message : String(candidate);
    return POOL_TIMEOUT_MESSAGES.some((m) => message.includes(m));
  });
}

/** Prisma P2028 when an interactive transaction gets no connection within `maxWait`: pool saturation. */
const TRANSACTION_START_MESSAGE = 'Unable to start a transaction in the given time';

/** Prisma P2028 message of an interactive transaction that outlived its timeout. */
const TRANSACTION_EXPIRED_MESSAGE = 'The timeout for this transaction was';

/** First error in `err`'s `cause` chain (at most five deep) that satisfies `predicate`. */
function findInCauseChain(err: unknown, predicate: (candidate: unknown) => boolean): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (predicate(current)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

const isP2028With =
  (text: string) =>
  (candidate: unknown): boolean =>
    (candidate as { code?: unknown }).code === 'P2028' &&
    candidate instanceof Error &&
    candidate.message.includes(text);

/**
 * True for Prisma `P2028` raised because an interactive transaction outlived
 * its timeout, in practice a waiter stuck on a row lock held by a concurrent
 * twin request (the supersede-resend, accept and Add Player transactions;
 * #908). A query on an already committed or rolled-back transaction is also
 * P2028 but is a bug and stays a 500. Duck-typed so this module keeps no
 * Prisma import.
 */
export function isTransactionTimeoutError(err: unknown): boolean {
  return findInCauseChain(err, isP2028With(TRANSACTION_EXPIRED_MESSAGE));
}

/**
 * True when the database is busy rather than the route broken: a pg pool
 * timeout, or Prisma P2028 for `maxWait` exhaustion (no connection to start a
 * transaction). Answered 503 with `Retry-After` and `DB_BUSY_BODY`.
 */
export function isDbBusyError(err: unknown): boolean {
  return isPoolTimeoutError(err) || findInCauseChain(err, isP2028With(TRANSACTION_START_MESSAGE));
}
