/**
 * Redis client and lightweight JSON cache helpers.
 *
 * Redis is used as a best-effort cache layer: if the connection is unavailable
 * the helpers degrade gracefully (cache reads return `null`, writes/deletes are
 * no-ops) so that a Redis outage never takes down a request path. Callers must
 * always be able to recompute the value from the source of truth.
 *
 * The client connects lazily on first use (`lazyConnect`) and retries with a
 * bounded backoff. Connection errors are logged once and then suppressed to
 * avoid log spam when Redis is intentionally absent (e.g. local dev / tests).
 */

import Redis from 'ioredis';
import { logger } from './logger';

let client: Redis | null = null;
let connectionErrorLogged = false;

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

  client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    // Bounded retry so a down Redis doesn't hang requests indefinitely.
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    enableOfflineQueue: false,
  });

  client.on('error', (err) => {
    if (!connectionErrorLogged) {
      logger.warn('Redis connection error — caching disabled until it recovers', {
        error: err.message,
      });
      connectionErrorLogged = true;
    }
  });

  client.on('ready', () => {
    connectionErrorLogged = false;
  });

  return client;
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
