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
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (POOL_TIMEOUT_MESSAGES.some((m) => message.includes(m))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
