/**
 * Redis client and lightweight JSON cache helpers.
 *
 * Redis is used as a best-effort cache layer: if the connection is unavailable
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

import Redis from 'ioredis';
import { logger } from './logger';

let client: Redis | null = null;
let connectionErrorLogged = false;

const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 30_000;

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
 * Get (or lazily create) the shared Redis client.
 *
 * Returns `null` when no `REDIS_URL` is configured, signalling callers to skip
 * caching entirely.
 */
export function getRedisClient(): Redis | null {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    return null;
  }

  const instance = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: redisRetryDelay,
    enableOfflineQueue: false,
  });
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
    if (client === instance) {
      client = null;
      logger.warn('Redis connection ended — a new client will be created on next use');
    }
  });

  return instance;
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
 * Close the Redis connection (used for graceful shutdown / test cleanup).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch {
      // Ignore — we're shutting down anyway.
    }
    client = null;
  }
}
