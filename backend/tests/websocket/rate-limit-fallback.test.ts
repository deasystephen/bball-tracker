/**
 * The Socket.io handshake limit against a mocked Redis (#452): the window
 * counts in Redis when it answers and in memory when it does not, a Redis
 * problem never refuses a handshake, the capacity check is per task and never
 * touches Redis, and the window is checked first (no further Redis work once
 * it is spent). The window against a real Redis:
 * tests/redis/socket-redis-adapter.redis.test.ts.
 */

const mockClient = {
  call: jest.fn(),
  eval: jest.fn(),
};

jest.mock('../../src/utils/redis', () => ({
  getRedisClient: () => mockClient,
  getReadyRedisClient: () => mockClient,
}));

import { logger } from '../../src/utils/logger';
import { sharedRedisBackoff } from '../../src/utils/redis-backoff';
import {
  MAX_CONCURRENT_PER_IP,
  MAX_HANDSHAKES_PER_WINDOW,
  checkHandshakeAllowed,
  evaluateHandshake,
  registerConnection,
  resetSocketRateLimits,
} from '../../src/websocket/rate-limit';

const IP = '203.0.113.9';

/** A Redis that answers the script loads and returns `hits` for every increment. */
function redisAnswers(hits: number): void {
  mockClient.call.mockImplementation(async (command: string) => (command === 'SCRIPT' ? 'sha' : [hits, 60_000]));
}

describe('websocket/rate-limit with a shared Redis', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockClient.call.mockReset();
    mockClient.eval.mockReset();
    sharedRedisBackoff.reset();
    resetSocketRateLimits();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
    resetSocketRateLimits();
  });

  it('uses the Redis count for the handshake window when Redis answers', async () => {
    redisAnswers(MAX_HANDSHAKES_PER_WINDOW);
    expect(await checkHandshakeAllowed(IP)).toBe(true);
    redisAnswers(MAX_HANDSHAKES_PER_WINDOW + 1);
    expect(await checkHandshakeAllowed(IP)).toBe(false);
    expect(mockClient.call).toHaveBeenCalledWith('EVALSHA', 'sha', '1', `rl:ws-hs:${IP}`, '60000');
  });

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

  it('checks the window first: once it is spent, nothing else is evaluated', async () => {
    for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) registerConnection(IP);
    redisAnswers(MAX_HANDSHAKES_PER_WINDOW + 1);
    expect(await evaluateHandshake(IP)).toBe(false);
    // One increment; the capacity check is in memory.
    expect(mockClient.call.mock.calls.filter(([c]) => c === 'EVALSHA')).toHaveLength(1);
    expect(mockClient.eval).not.toHaveBeenCalled();
  });

  it('applies the per-task capacity in memory, never through Redis', async () => {
    redisAnswers(1);
    for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) registerConnection(IP);
    expect(await evaluateHandshake(IP)).toBe(false);
    expect(await evaluateHandshake('198.51.100.7')).toBe(true);
    expect(mockClient.eval).not.toHaveBeenCalled();
  });
});
