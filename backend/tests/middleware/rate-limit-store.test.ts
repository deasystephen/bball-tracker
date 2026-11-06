/**
 * `SharedRateLimitStore` (#452): Redis when it answers, this task's memory
 * when it does not, and never an error to the limiter. The store against a
 * real Redis is exercised in tests/integration/socket-redis-adapter.redis.test.ts.
 */

const mockCall = jest.fn();
let mockClientConfigured = true;

jest.mock('../../src/utils/redis', () => ({
  getReadyRedisClient: () => (mockClientConfigured ? { call: mockCall } : null),
}));

import type { Options } from 'express-rate-limit';
import { logger } from '../../src/utils/logger';
import {
  REDIS_RETRY_AFTER_FAILURE_MS,
  SharedRateLimitStore,
  resetRateLimitStoreOutageLog,
} from '../../src/api/middleware/rate-limit-store';

const OPTIONS = { windowMs: 60_000 } as Options;

/** A minimal Redis that answers the two script loads and the increment script. */
function healthyRedis(totalHits: number): void {
  mockCall.mockImplementation(async (command: string) => {
    if (command === 'SCRIPT') return 'sha';
    if (command === 'EVALSHA') return [totalHits, 30_000];
    return 1;
  });
}

describe('SharedRateLimitStore', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockClientConfigured = true;
    mockCall.mockReset();
    resetRateLimitStoreOutageLog();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });

  it('prefixes its keys with rl:<name>: and is not local', () => {
    const store = new SharedRateLimitStore('export');
    expect(store.prefix).toBe('rl:export:');
    expect(store.localKeys).toBe(false);
  });

  it('counts in memory when no Redis is configured', async () => {
    mockClientConfigured = false;
    const store = new SharedRateLimitStore('t1');
    store.init(OPTIONS);
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    expect(mockCall).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    store.shutdown();
  });

  it('returns the Redis count, under the limiter prefix, when Redis answers', async () => {
    healthyRedis(7);
    const store = new SharedRateLimitStore('t2');
    store.init(OPTIONS);
    expect((await store.increment('1.2.3.4')).totalHits).toBe(7);
    expect(mockCall).toHaveBeenCalledWith('EVALSHA', 'sha', '1', 'rl:t2:1.2.3.4', '60000');
    store.shutdown();
  });

  it('falls back to memory on a Redis error, logs once, and retries Redis after the cooldown', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockCall.mockRejectedValue(new Error('Command timed out'));
    const store = new SharedRateLimitStore('t3');
    store.init(OPTIONS);

    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    // Inside the cooldown Redis is not touched at all.
    const callsDuringCooldown = mockCall.mock.calls.length;
    await store.increment('k');
    expect(mockCall.mock.calls.length).toBe(callsDuringCooldown);

    healthyRedis(42);
    jest.setSystemTime(1_000_000 + REDIS_RETRY_AFTER_FAILURE_MS);
    expect((await store.increment('k')).totalHits).toBe(42);
    store.shutdown();
  });

  it('never throws from decrement or resetKey while Redis is failing', async () => {
    mockCall.mockRejectedValue(new Error('ECONNREFUSED'));
    const store = new SharedRateLimitStore('t4');
    store.init(OPTIONS);
    await store.increment('k');
    await expect(store.decrement('k')).resolves.toBeUndefined();
    await expect(store.resetKey('k')).resolves.toBeUndefined();
    expect((await store.increment('k')).totalHits).toBe(1);
    store.shutdown();
  });
});
