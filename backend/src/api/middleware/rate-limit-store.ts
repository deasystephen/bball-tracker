/**
 * Shared, fail-open store for the `express-rate-limit` limiters (#452).
 *
 * Each limiter in `rate-limit.ts` gets its own `SharedRateLimitStore`, which
 * counts in Redis through `rate-limit-redis` when the shared client
 * (`utils/redis.ts#getRedisClient`, `REDIS_URL`) is configured and answering,
 * so every API task sees the same counters. Redis is a best-effort dependency
 * in this codebase, so the store never rejects a request because of Redis:
 *
 *  - no `REDIS_URL` (local dev without Redis, the Jest suites), or a client
 *    not connected yet or reconnecting: the hit goes to an in-process
 *    `MemoryStore`, the pre-#452 behaviour;
 *  - a Redis error or timeout (`REDIS_COMMAND_TIMEOUT_MS`): that hit, and every
 *    hit for the next `REDIS_RETRY_AFTER_FAILURE_MS`, is counted in the
 *    in-process `MemoryStore` instead, so the limit still holds per task while
 *    Redis is down. The outage is logged once at `warn`, the recovery at `info`.
 *
 * The window is the same fixed window from the first hit in both stores, and
 * the key is whatever the limiter's `keyGenerator` returns; the Redis key adds
 * the limiter's own `prefix`, so two limiters keyed on the same IP never share
 * a counter (the in-process stores were per limiter by construction).
 */

import { MemoryStore, type ClientRateLimitInfo, type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getReadyRedisClient } from '../../utils/redis';
import { logger } from '../../utils/logger';

/** Every Redis rate-limit key starts with this, then the limiter's own name. */
export const RATE_LIMIT_KEY_PREFIX = 'rl:';

/** How long a store counts in memory after a Redis failure before trying Redis again. */
export const REDIS_RETRY_AFTER_FAILURE_MS = 5_000;

class RedisUnavailableError extends Error {
  constructor() {
    super('Redis client not configured');
    this.name = 'RedisUnavailableError';
  }
}

/** Sends one raw command through the shared client, resolved on every call. */
async function sendCommand(...args: string[]): Promise<RedisReply> {
  const client = getReadyRedisClient();
  if (!client) throw new RedisUnavailableError();
  const [command, ...rest] = args;
  return (await client.call(command, ...rest)) as RedisReply;
}

/** Logged once per outage across every limiter, so a Redis blip is one line, not one per limiter. */
let outageLogged = false;

export class SharedRateLimitStore implements Store {
  /** Keys are shared across tasks, never local to this instance. */
  readonly localKeys = false;
  readonly prefix: string;

  private readonly memory = new MemoryStore();
  private options: Options | null = null;
  private redisStore: Promise<RedisStore> | null = null;
  private redisRetryAt = 0;

  /**
   * @param name The limiter's name, unique per limiter (`api`, `auth`, …): it
   *   becomes the Redis key prefix `rl:<name>:`.
   */
  constructor(name: string) {
    this.prefix = `${RATE_LIMIT_KEY_PREFIX}${name}:`;
  }

  init(options: Options): void {
    this.options = options;
    this.memory.init(options);
  }

  /**
   * The Redis-backed store, created (and its Lua scripts loaded) on first use
   * and again after each failure, so a script load that failed during an
   * outage is retried once Redis is back. `null` means "count in memory".
   */
  private async redis(now: number): Promise<RedisStore | null> {
    if (!this.options || !getReadyRedisClient() || now < this.redisRetryAt) return null;
    if (!this.redisStore) {
      const store = new RedisStore({ sendCommand, prefix: this.prefix });
      const ready = store.init(this.options).then(() => store);
      // Awaited by the caller; this only stops an unobserved rejection.
      ready.catch(() => undefined);
      this.redisStore = ready;
    }
    return this.redisStore;
  }

  private redisFailed(operation: string, error: unknown, now: number): void {
    this.redisStore = null;
    this.redisRetryAt = now + REDIS_RETRY_AFTER_FAILURE_MS;
    if (!outageLogged && !(error instanceof RedisUnavailableError)) {
      outageLogged = true;
      logger.warn('Rate limit store: Redis unavailable, counting in memory', {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private redisSucceeded(): void {
    if (outageLogged) {
      outageLogged = false;
      logger.info('Rate limit store: Redis recovered');
    }
  }

  private async withRedis<T>(
    operation: string,
    viaRedis: (store: RedisStore) => Promise<T>,
    viaMemory: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    try {
      const store = await this.redis(now);
      if (store) {
        const result = await viaRedis(store);
        this.redisSucceeded();
        return result;
      }
    } catch (error) {
      this.redisFailed(operation, error, now);
    }
    return viaMemory();
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    return this.withRedis('get', (s) => s.get(key), () => this.memory.get(key));
  }

  async increment(key: string): Promise<IncrementResponse> {
    return this.withRedis('increment', (s) => s.increment(key), () => this.memory.increment(key));
  }

  async decrement(key: string): Promise<void> {
    await this.withRedis('decrement', (s) => s.decrement(key), () => this.memory.decrement(key));
  }

  async resetKey(key: string): Promise<void> {
    // Clear both: a key may have been counted in memory during an outage.
    await this.memory.resetKey(key);
    await this.withRedis('resetKey', (s) => s.resetKey(key), async () => undefined);
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}

/** Test-only: forget that an outage was logged. */
export function resetRateLimitStoreOutageLog(): void {
  outageLogged = false;
}
