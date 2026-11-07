/**
 * Redis client and lightweight JSON cache helpers.
 *
 * Redis is used as a best-effort cache layer and as the shared rate-limit
 * store (`api/middleware/rate-limit-store.ts`, `websocket/rate-limit.ts`): if the connection is unavailable
 * the helpers degrade gracefully (cache reads return `null`, writes/deletes are
 * no-ops) so that a Redis outage never takes down a request path. Callers must
 * always be able to recompute the value from the source of truth.
 *
 * The client connects lazily on first use (`lazyConnect`) and keeps retrying
 * with a capped exponential backoff — it never gives up, because a Redis blip
 * must not permanently disable caching for the life of the process (audit
 * #50). If the connection does end for good (e.g. `quit()`), the client is
 * dropped so the next cache access recreates it. Connection errors are logged
 * once and then suppressed to avoid log spam when Redis is intentionally absent
 * (e.g. local dev / tests).
 */

import Redis, { type RedisOptions } from 'ioredis';
import { logger } from './logger';

let client: Redis | null = null;
let connectionErrorLogged = false;
/**
 * Set by `closeRedis()` (shutdown): from then on no client is created again,
 * so a rate-limit check or cache call that races the shutdown gets `null`
 * (fail-open) instead of opening a fresh connection the process then waits on.
 */
let closed = false;

const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 30_000;

/**
 * Upper bound on one command (#452). The rate limiters sit on every request
 * now, so a Redis that accepts the connection but stops answering must fail
 * the command (and the caller falls back) rather than hold the request open.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 500;

/**
 * ioredis `retryStrategy`: always returns a delay (never `null`), doubling from
 * 200ms and capped at 30s, so the client keeps reconnecting indefinitely.
 * Individual commands still fail fast while disconnected (`enableOfflineQueue:
 * false` + `maxRetriesPerRequest: 1`), so requests are never held up.
 */
export function redisRetryDelay(times: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, times - 1), RETRY_MAX_MS);
}

/**
 * The connection options every request-path Redis client in the API uses: the
 * cache and rate-limit client below and the Socket.io adapter's publisher
 * (`websocket/redis-adapter.ts`). TLS and AUTH come from the URL itself
 * (`rediss://:<token>@host:port`, #755), so a URL change is the only switch.
 */
export function redisClientOptions(): RedisOptions {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: redisRetryDelay,
    enableOfflineQueue: false,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  };
}

/**
 * Get (or lazily create) the shared Redis client.
 *
 * Returns `null` when no `REDIS_URL` is configured, or after `closeRedis()`,
 * signalling callers to skip Redis entirely.
 */
export function getRedisClient(): Redis | null {
  if (closed) return null;
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    return null;
  }

  const instance = new Redis(url, redisClientOptions());
  client = instance;

  instance.on('error', (err) => {
    if (!connectionErrorLogged) {
      logger.warn('Redis connection error — caching disabled until it recovers', {
        error: err.message,
      });
      connectionErrorLogged = true;
    }
  });

  instance.on('ready', () => {
    connectionErrorLogged = false;
  });

  // `end` fires when ioredis will not reconnect on its own (e.g. after
  // `quit()`). Drop the dead client so the next cache access creates a fresh one.
  instance.on('end', () => {
    if (client === instance && !closed) {
      client = null;
      logger.warn('Redis connection ended — a new client will be created on next use');
    }
  });

  return instance;
}

/**
 * The shared client when it is connected and ready for commands, else `null`.
 * A client that has not connected yet (`lazyConnect`) is told to connect, so
 * the next call finds it ready. For callers on the request path that must not
 * spend a failed command (and its log line) on a connection still being made:
 * the rate limiters, which count in memory meanwhile.
 */
export function getReadyRedisClient(): Redis | null {
  const redis = getRedisClient();
  if (!redis) return null;
  if (redis.status === 'ready') return redis;
  if (redis.status === 'wait') {
    redis.connect().catch(() => {
      // Logged by the 'error' listener; retried by the retry strategy.
    });
  }
  return null;
}

/**
 * Read and JSON-parse a cached value. Returns `null` on miss, parse failure, or
 * any Redis error (fail-open).
 */
export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.debug('cacheGetJson failed (ignored)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * JSON-serialize and cache a value with a TTL (seconds). No-op / fail-open on
 * any Redis error.
 */
export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.debug('cacheSetJson failed (ignored)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete one or more cache keys. No-op / fail-open on any Redis error.
 */
export async function cacheDelete(...keys: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis || keys.length === 0) return;

  try {
    await redis.del(...keys);
  } catch (err) {
    logger.debug('cacheDelete failed (ignored)', {
      keys,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Close the Redis connection. Called by the SIGTERM/SIGINT routine in
 * `utils/shutdown.ts` (wired in `src/index.ts`) and by test cleanup.
 */
export async function closeRedis(): Promise<void> {
  closed = true;
  if (client) {
    const closing = client;
    client = null;
    try {
      await closing.quit();
    } catch {
      // Ignore — we're shutting down anyway.
    }
  }
}
