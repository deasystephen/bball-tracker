/**
 * Fail-open behaviour of the shared Socket.io limiters (#452): a Redis client
 * that errors on every command must never refuse a handshake on its own, and
 * this task's in-memory counters must still hold the limits.
 */

const mockClient = {
  eval: jest.fn(),
  set: jest.fn(),
};

jest.mock('../../src/utils/redis', () => ({
  getRedisClient: () => mockClient,
  getReadyRedisClient: () => mockClient,
}));

import { logger } from '../../src/utils/logger';
import {
  MAX_CONCURRENT_PER_IP,
  MAX_HANDSHAKES_PER_WINDOW,
  checkHandshakeAllowed,
  hasConcurrentCapacity,
  registerConnection,
  releaseConnection,
  resetSocketRateLimits,
} from '../../src/websocket/rate-limit';

describe('websocket/rate-limit with Redis failing', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetSocketRateLimits();
    mockClient.eval.mockRejectedValue(new Error('Command timed out'));
    mockClient.set.mockRejectedValue(new Error('Command timed out'));
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
    resetSocketRateLimits();
  });

  it('falls back to the local handshake window and logs the outage once', async () => {
    const now = 1_000_000;
    for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
      expect(await checkHandshakeAllowed('203.0.113.9', now)).toBe(true);
    }
    expect(await checkHandshakeAllowed('203.0.113.9', now)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Socket rate limit: Redis unavailable, counting in memory',
      expect.objectContaining({ operation: 'handshake' })
    );
  });

  it('falls back to the local concurrency count', async () => {
    for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) {
      expect(await hasConcurrentCapacity('203.0.113.9')).toBe(true);
      await registerConnection('203.0.113.9');
    }
    expect(await hasConcurrentCapacity('203.0.113.9')).toBe(false);
    await releaseConnection('203.0.113.9');
    expect(await hasConcurrentCapacity('203.0.113.9')).toBe(true);
  });

  it('uses the shared count when Redis answers, ignoring the local one', async () => {
    mockClient.eval.mockResolvedValue(MAX_HANDSHAKES_PER_WINDOW + 1);
    expect(await checkHandshakeAllowed('198.51.100.7', 1_000_000)).toBe(false);
    mockClient.eval.mockResolvedValue(MAX_CONCURRENT_PER_IP);
    expect(await hasConcurrentCapacity('198.51.100.7')).toBe(false);
    mockClient.eval.mockResolvedValue(0);
    expect(await hasConcurrentCapacity('198.51.100.7')).toBe(true);
  });
});
