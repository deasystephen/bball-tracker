/**
 * The shared Socket.io limiters against a mocked Redis (#452): fail-open when
 * Redis errors or is not ready, the capacity check as "other tasks + this
 * task's local count", and the self-healing absolute writes (a write lost to a
 * blip, or made before the client was ready, is corrected by the heartbeat).
 * The same behaviour against a real Redis:
 * tests/integration/socket-redis-adapter.redis.test.ts.
 */

const mockClient = {
  eval: jest.fn(),
  call: jest.fn(),
};
const mockRedisState = { configured: true, ready: true };

jest.mock('../../src/utils/redis', () => ({
  getRedisClient: () => (mockRedisState.configured ? mockClient : null),
  getReadyRedisClient: () => (mockRedisState.configured && mockRedisState.ready ? mockClient : null),
}));

import { logger } from '../../src/utils/logger';
import { REDIS_RETRY_AFTER_FAILURE_MS, resetRateLimitStoreOutageLog } from '../../src/api/middleware/rate-limit-store';
import {
  INSTANCE_ID,
  MAX_CONCURRENT_PER_IP,
  MAX_HANDSHAKES_PER_WINDOW,
  checkHandshakeAllowed,
  hasConcurrentCapacity,
  isHeartbeatRunning,
  registerConnection,
  releaseConnection,
  resetSocketRateLimits,
  runHeartbeatNow,
} from '../../src/websocket/rate-limit';

const IP = '203.0.113.9';

/** Redis answers: the count script with `others`, every write with 1. */
function redisAnswers(others: number): void {
  mockClient.eval.mockImplementation(async (script: string) => (script.includes('HGETALL') ? others : 1));
}

/** The absolute counts written for IP, in order (a SYNC_SCRIPT call's ARGV[2]). */
function writtenCounts(): number[] {
  return mockClient.eval.mock.calls
    .filter(([script, , hash]) => !String(script).includes('HGETALL') && hash === `ws:conc:${IP}`)
    .map((call) => Number(call[5]));
}

describe('websocket/rate-limit with a shared Redis', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRedisState.configured = true;
    mockRedisState.ready = true;
    mockClient.eval.mockReset();
    mockClient.call.mockReset();
    resetRateLimitStoreOutageLog();
    resetSocketRateLimits();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
    resetSocketRateLimits();
    jest.useRealTimers();
  });

  describe('fail-open', () => {
    it('counts handshakes in memory when Redis errors, and logs the outage once', async () => {
      mockClient.call.mockRejectedValue(new Error('Command timed out'));
      for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
        expect(await checkHandshakeAllowed(IP)).toBe(true);
      }
      expect(await checkHandshakeAllowed(IP)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Rate limit store: Redis unavailable, counting in memory',
        expect.objectContaining({ operation: 'increment' })
      );
    });

    it('uses the local concurrency count alone when Redis errors', async () => {
      mockClient.eval.mockRejectedValue(new Error('Command timed out'));
      for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) {
        expect(await hasConcurrentCapacity(IP)).toBe(true);
        await registerConnection(IP);
      }
      expect(await hasConcurrentCapacity(IP)).toBe(false);
      await releaseConnection(IP);
      expect(await hasConcurrentCapacity(IP)).toBe(true);
    });

    it('never refuses because of Redis: with no local sockets a failing Redis allows', async () => {
      mockClient.eval.mockRejectedValue(new Error('ECONNRESET'));
      expect(await hasConcurrentCapacity(IP)).toBe(true);
    });
  });

  describe('capacity: other tasks plus this task', () => {
    it('adds the live other tasks from Redis to the local count', async () => {
      redisAnswers(MAX_CONCURRENT_PER_IP - 1);
      expect(await hasConcurrentCapacity(IP)).toBe(true);
      await registerConnection(IP);
      expect(await hasConcurrentCapacity(IP)).toBe(false);
      // The count script excludes this task's own field (ARGV[2]).
      const countCall = mockClient.eval.mock.calls.find(([script]) => String(script).includes('HGETALL'));
      expect(countCall?.[4]).toBe(INSTANCE_ID);
    });
  });

  describe('self-healing absolute writes', () => {
    it('writes the absolute count on every change, and 0 (field deleted) on the last release', async () => {
      redisAnswers(0);
      await registerConnection(IP);
      await registerConnection(IP);
      await releaseConnection(IP);
      await releaseConnection(IP);
      expect(writtenCounts()).toEqual([1, 2, 1, 0]);
    });

    it('a register made before the client was ready reaches Redis on the next heartbeat', async () => {
      mockRedisState.ready = false;
      redisAnswers(0);
      await registerConnection(IP);
      await registerConnection(IP);
      expect(mockClient.eval).not.toHaveBeenCalled();
      expect(isHeartbeatRunning()).toBe(true);

      mockRedisState.ready = true;
      await runHeartbeatNow();
      expect(writtenCounts()).toEqual([2]);
    });

    it('a release lost to a Redis blip is corrected by the next heartbeat, then the heartbeat stops', async () => {
      redisAnswers(0);
      await registerConnection(IP);
      expect(writtenCounts()).toEqual([1]);

      mockClient.eval.mockRejectedValue(new Error('Command timed out'));
      await releaseConnection(IP);
      expect(isHeartbeatRunning()).toBe(true);

      // Inside the back-off nothing is sent; after it the heartbeat rewrites 0.
      redisAnswers(0);
      mockClient.eval.mockClear();
      await runHeartbeatNow();
      expect(writtenCounts()).toEqual([]);
      jest.setSystemTime(1_000_000 + REDIS_RETRY_AFTER_FAILURE_MS);
      await runHeartbeatNow();
      expect(writtenCounts()).toEqual([0]);

      // Nothing held and nothing unsynced: the next tick stops the heartbeat.
      await runHeartbeatNow();
      expect(isHeartbeatRunning()).toBe(false);
    });

    it('the heartbeat rewrites the counts it holds and keeps running while it holds sockets', async () => {
      redisAnswers(0);
      await registerConnection(IP);
      mockClient.eval.mockClear();
      await runHeartbeatNow();
      expect(writtenCounts()).toEqual([1]);
      expect(isHeartbeatRunning()).toBe(true);
    });

    it('starts no heartbeat and sends nothing without a configured Redis', async () => {
      mockRedisState.configured = false;
      await registerConnection(IP);
      expect(isHeartbeatRunning()).toBe(false);
      expect(mockClient.eval).not.toHaveBeenCalled();
    });
  });
});
