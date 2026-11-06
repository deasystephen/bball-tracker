/**
 * The one back-off policy for every rate-limit counter that lives in Redis
 * (#452): the HTTP stores (`api/middleware/rate-limit-store.ts`), including
 * the Socket.io handshake window (`websocket/rate-limit.ts`). They all use the one shared
 * client (`utils/redis.ts`), so they share ONE `RedisBackoff`
 * (`sharedRedisBackoff`): an outage seen by any of them sends all of them to
 * memory, and they recover together.
 *
 * - **Healthy:** every caller goes to Redis.
 * - **After a failure** (an error or the 500 ms `commandTimeout`): every caller
 *   counts in memory for `REDIS_RETRY_AFTER_FAILURE_MS`. The first failure of
 *   an outage logs one `warn`.
 * - **Probe, single-flight:** once that window has passed, exactly ONE caller
 *   tries Redis; everyone else keeps using memory while it is in flight
 *   rather than queueing behind it. Success ends the outage (one `info`);
 *   failure starts a new window.
 *
 * What a stall costs: the requests already in flight when Redis stops
 * answering (it still looks `ready`) each wait up to `REDIS_COMMAND_TIMEOUT_MS`
 * once, since nothing has failed yet. From the first failure on, single-flight
 * applies: at most one request per window waits on Redis, never every
 * request.
 *
 * A client that is not configured or not ready is not an outage: the caller
 * throws `RedisUnavailableError`, counts in memory, and nothing is logged
 * (`utils/redis.ts` logs connection errors itself).
 */

import { logger } from './logger';

/** How long callers count in memory after a Redis failure before one probes again. */
export const REDIS_RETRY_AFTER_FAILURE_MS = 5_000;

/** Thrown by a caller's Redis operation when there is no ready client to use. */
export class RedisUnavailableError extends Error {
  constructor() {
    super('Redis client not configured or not ready');
    this.name = 'RedisUnavailableError';
  }
}

export type BackoffResult<T> = { ok: true; value: T } | { ok: false };

export class RedisBackoff {
  private degraded = false;
  private retryAt = 0;
  private probing = false;

  /**
   * Run `operation` against Redis if the policy allows it now. Resolves
   * `{ ok: false }` (never rejects) when the caller should count in memory:
   * inside a back-off window, while another caller's probe is in flight, or
   * when `operation` itself failed.
   */
  async attempt<T>(name: string, operation: () => Promise<T>): Promise<BackoffResult<T>> {
    const now = Date.now();
    let isProbe = false;
    if (this.degraded) {
      if (now < this.retryAt || this.probing) return { ok: false };
      this.probing = true;
      isProbe = true;
    }
    try {
      const value = await operation();
      if (this.degraded) {
        this.degraded = false;
        logger.info('Rate limit store: Redis recovered');
      }
      return { ok: true, value };
    } catch (error) {
      if (!(error instanceof RedisUnavailableError)) {
        if (!this.degraded) {
          logger.warn('Rate limit store: Redis unavailable, counting in memory', {
            operation: name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.degraded = true;
        this.retryAt = Date.now() + REDIS_RETRY_AFTER_FAILURE_MS;
      }
      return { ok: false };
    } finally {
      if (isProbe) this.probing = false;
    }
  }

  /** Whether an outage is in progress. */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** Forget any outage in progress. Test-only. */
  reset(): void {
    this.degraded = false;
    this.retryAt = 0;
    this.probing = false;
  }
}

/** The back-off shared by every user of the shared Redis client. */
export const sharedRedisBackoff = new RedisBackoff();
