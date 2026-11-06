/**
 * Shared, fail-open store for the `express-rate-limit` limiters (#452).
 *
 * Each limiter in `rate-limit.ts` gets its own `SharedRateLimitStore`, which
 * counts in Redis through `rate-limit-redis` when the shared client
 * (`utils/redis.ts#getReadyRedisClient`, `REDIS_URL`) is configured and
 * answering, so every API task sees the same counters. Redis is a best-effort
 * dependency in this codebase, so the store never rejects a request because of
 * Redis: with no `REDIS_URL`, a client not connected yet, or whenever the
 * shared back-off (`utils/redis-backoff.ts#sharedRedisBackoff`, one for every
 * store, the Socket.io handshake window included) says so, the hit goes to this limiter's
 * in-process `MemoryStore`, so the limit still holds per task.
 *
 * The window is the same fixed window from the first hit in both stores, and
 * the key is whatever the limiter's `keyGenerator` returns; the Redis key adds
 * the limiter's own `prefix`, so two limiters keyed on the same IP never share
 * a counter (the in-process stores were per limiter by construction).
 */

import { MemoryStore, type ClientRateLimitInfo, type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getReadyRedisClient } from '../../utils/redis';
import { RedisUnavailableError, sharedRedisBackoff } from '../../utils/redis-backoff';

/** Every Redis rate-limit key starts with this, then the limiter's own name. */
export const RATE_LIMIT_KEY_PREFIX = 'rl:';

/** Sends one raw command through the shared client, resolved on every call. */
async function sendCommand(...args: string[]): Promise<RedisReply> {
  const client = getReadyRedisClient();
  if (!client) throw new RedisUnavailableError();
  const [command, ...rest] = args;
  return (await client.call(command, ...rest)) as RedisReply;
}

export class SharedRateLimitStore implements Store {
  /** Keys are shared across tasks, never local to this instance. */
  readonly localKeys = false;
  readonly prefix: string;

  private readonly memory = new MemoryStore();
  private options: Options | null = null;
  private redisStore: Promise<RedisStore> | null = null;

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
   * outage is retried once Redis is back.
   */
  private redis(): Promise<RedisStore> {
    if (!this.options || !getReadyRedisClient()) return Promise.reject(new RedisUnavailableError());
    if (!this.redisStore) {
      const store = new RedisStore({ sendCommand, prefix: this.prefix });
      const ready = store.init(this.options).then(() => store);
      // Awaited by the caller; this only stops an unobserved rejection.
      ready.catch(() => undefined);
      this.redisStore = ready;
    }
    return this.redisStore;
  }

  /**
   * One operation through the shared back-off; memory when it says no.
   *
   * A command that timed out (`REDIS_COMMAND_TIMEOUT_MS`) may still have been
   * applied by Redis, and the hit is then counted again in memory: briefly a
   * double count. That is accepted on purpose: it errs toward the stricter
   * limit, only for the hits of that one failure, and the memory count lasts
   * one window at most.
   */
  private async withRedis<T>(
    operation: string,
    viaRedis: (store: RedisStore) => Promise<T>,
    viaMemory: () => Promise<T>
  ): Promise<T> {
    const result = await sharedRedisBackoff.attempt(operation, async () => {
      try {
        return await viaRedis(await this.redis());
      } catch (error) {
        if (!(error instanceof RedisUnavailableError)) this.redisStore = null;
        throw error;
      }
    });
    return result.ok ? result.value : viaMemory();
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
