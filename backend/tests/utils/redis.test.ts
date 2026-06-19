/**
 * Unit tests for the Redis cache helpers.
 *
 * Verifies the fail-open behavior: with no REDIS_URL configured the helpers
 * must no-op (reads return null, writes/deletes do nothing) so a missing or
 * down Redis never breaks a request path. Also exercises the happy path with a
 * mocked ioredis client.
 */

const mockRedisInstance = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  quit: jest.fn(),
  on: jest.fn(),
};

const RedisCtor = jest.fn(() => mockRedisInstance);

jest.mock('ioredis', () => ({
  __esModule: true,
  default: RedisCtor,
}));

describe('redis cache helpers', () => {
  const ORIGINAL_ENV = process.env.REDIS_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    process.env.REDIS_URL = ORIGINAL_ENV;
  });

  describe('when REDIS_URL is not configured', () => {
    beforeEach(() => {
      delete process.env.REDIS_URL;
    });

    it('getRedisClient returns null', async () => {
      const { getRedisClient } = await import('../../src/utils/redis');
      expect(getRedisClient()).toBeNull();
      expect(RedisCtor).not.toHaveBeenCalled();
    });

    it('cacheGetJson returns null without touching Redis', async () => {
      const { cacheGetJson } = await import('../../src/utils/redis');
      await expect(cacheGetJson('k')).resolves.toBeNull();
      expect(mockRedisInstance.get).not.toHaveBeenCalled();
    });

    it('cacheSetJson and cacheDelete are no-ops', async () => {
      const { cacheSetJson, cacheDelete } = await import('../../src/utils/redis');
      await cacheSetJson('k', { a: 1 }, 60);
      await cacheDelete('k');
      expect(mockRedisInstance.set).not.toHaveBeenCalled();
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });
  });

  describe('when REDIS_URL is configured', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
    });

    it('cacheGetJson parses stored JSON', async () => {
      mockRedisInstance.get.mockResolvedValue(JSON.stringify({ teams: 2 }));
      const { cacheGetJson } = await import('../../src/utils/redis');

      await expect(cacheGetJson('usage:counts:u1')).resolves.toEqual({ teams: 2 });
      expect(mockRedisInstance.get).toHaveBeenCalledWith('usage:counts:u1');
    });

    it('cacheGetJson returns null on a miss', async () => {
      mockRedisInstance.get.mockResolvedValue(null);
      const { cacheGetJson } = await import('../../src/utils/redis');
      await expect(cacheGetJson('miss')).resolves.toBeNull();
    });

    it('cacheGetJson fails open (returns null) on a Redis error', async () => {
      mockRedisInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const { cacheGetJson } = await import('../../src/utils/redis');
      await expect(cacheGetJson('boom')).resolves.toBeNull();
    });

    it('cacheSetJson serializes and sets a TTL', async () => {
      mockRedisInstance.set.mockResolvedValue('OK');
      const { cacheSetJson } = await import('../../src/utils/redis');

      await cacheSetJson('k', { teams: 1 }, 60);
      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        'k',
        JSON.stringify({ teams: 1 }),
        'EX',
        60
      );
    });

    it('cacheSetJson fails open on a Redis error', async () => {
      mockRedisInstance.set.mockRejectedValue(new Error('down'));
      const { cacheSetJson } = await import('../../src/utils/redis');
      await expect(cacheSetJson('k', {}, 60)).resolves.toBeUndefined();
    });

    it('cacheDelete removes keys', async () => {
      mockRedisInstance.del.mockResolvedValue(1);
      const { cacheDelete } = await import('../../src/utils/redis');

      await cacheDelete('a', 'b');
      expect(mockRedisInstance.del).toHaveBeenCalledWith('a', 'b');
    });

    it('cacheDelete is a no-op when given no keys', async () => {
      const { cacheDelete } = await import('../../src/utils/redis');
      await cacheDelete();
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });

    it('cacheDelete fails open on a Redis error', async () => {
      mockRedisInstance.del.mockRejectedValue(new Error('down'));
      const { cacheDelete } = await import('../../src/utils/redis');
      await expect(cacheDelete('k')).resolves.toBeUndefined();
    });

    it('reuses a single client across calls', async () => {
      mockRedisInstance.get.mockResolvedValue(null);
      const { getRedisClient } = await import('../../src/utils/redis');
      getRedisClient();
      getRedisClient();
      expect(RedisCtor).toHaveBeenCalledTimes(1);
    });

    it('closeRedis quits the client', async () => {
      mockRedisInstance.quit.mockResolvedValue('OK');
      const mod = await import('../../src/utils/redis');
      mod.getRedisClient();
      await mod.closeRedis();
      expect(mockRedisInstance.quit).toHaveBeenCalled();
    });
  });
});
