/**
 * Unit tests for the usage metering service.
 *
 * Covers:
 *  - usage calculation correctness (teams + distinct seasons vs tier limits)
 *  - Redis caching (cache hit skips DB; cache miss computes + populates)
 *  - cache invalidation on writes
 *  - the grandfather rule (already-over-limit users keep teams but can't add)
 *  - effective-tier handling (expired paid tier falls back to FREE)
 */

import { mockPrisma } from '../setup';

// Mock the Redis cache helpers so we can control hits/misses without a server.
jest.mock('../../src/utils/redis', () => ({
  cacheGetJson: jest.fn(),
  cacheSetJson: jest.fn(),
  cacheDelete: jest.fn(),
}));

import {
  getUsage,
  computeCounts,
  canCreateTeam,
  invalidateUsage,
  USAGE_CACHE_TTL_SECONDS,
} from '../../src/services/usage-service';
import { cacheGetJson, cacheSetJson, cacheDelete } from '../../src/utils/redis';

const mockCacheGetJson = cacheGetJson as jest.Mock;
const mockCacheSetJson = cacheSetJson as jest.Mock;
const mockCacheDelete = cacheDelete as jest.Mock;

const USER_ID = 'user-123';

function mockUserTier(
  tier: 'FREE' | 'PREMIUM' | 'LEAGUE',
  expiresAt: Date | null = null
): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
    subscriptionTier: tier,
    subscriptionExpiresAt: expiresAt,
  });
}

/** Set up the DB counts returned by computeCounts. */
function mockDbCounts(teamCount: number, seasonIds: string[]): void {
  (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(teamCount);
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue(
    seasonIds.map((seasonId) => ({ team: { seasonId } }))
  );
}

describe('usage-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: cache miss.
    mockCacheGetJson.mockResolvedValue(null);
  });

  describe('computeCounts', () => {
    it('counts teams and distinct seasons from the database', async () => {
      mockDbCounts(3, ['s1', 's1', 's2']); // 3 teams across 2 distinct seasons

      const counts = await computeCounts(USER_ID);

      expect(counts).toEqual({ teams: 3, seasons: 2 });
      expect(mockPrisma.teamStaff.count).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
    });

    it('returns zero usage for a user with no teams', async () => {
      mockDbCounts(0, []);

      const counts = await computeCounts(USER_ID);

      expect(counts).toEqual({ teams: 0, seasons: 0 });
    });
  });

  describe('getUsage — calculation correctness', () => {
    it('reports FREE-tier usage vs limits with limitReached when under the cap', async () => {
      mockUserTier('FREE');
      mockDbCounts(2, ['s1', 's2']);

      const usage = await getUsage(USER_ID);

      expect(usage.tier).toBe('FREE');
      expect(usage.teams).toEqual({ count: 2, limit: 3, limitReached: false });
      expect(usage.seasons.limit).toBe(1);
      // 2 seasons against a limit of 1 => limit reached
      expect(usage.seasons).toEqual({ count: 2, limit: 1, limitReached: true });
    });

    it('marks teams.limitReached true when exactly at the cap', async () => {
      mockUserTier('FREE');
      mockDbCounts(3, ['s1']);

      const usage = await getUsage(USER_ID);

      expect(usage.teams).toEqual({ count: 3, limit: 3, limitReached: true });
    });

    it('normalizes unlimited (Infinity) limits to null for PREMIUM', async () => {
      mockUserTier('PREMIUM', new Date(Date.now() + 86_400_000));
      mockDbCounts(10, ['s1', 's2', 's3']);

      const usage = await getUsage(USER_ID);

      expect(usage.tier).toBe('PREMIUM');
      expect(usage.teams).toEqual({ count: 10, limit: null, limitReached: false });
      expect(usage.seasons.limit).toBeNull();
      expect(usage.seasons.limitReached).toBe(false);
    });

    it('falls back to FREE limits when a paid subscription has expired', async () => {
      mockUserTier('PREMIUM', new Date('2020-01-01'));
      mockDbCounts(5, ['s1']);

      const usage = await getUsage(USER_ID);

      // Effective tier is FREE => the 5 existing teams are over the cap of 3.
      expect(usage.tier).toBe('FREE');
      expect(usage.teams).toEqual({ count: 5, limit: 3, limitReached: true });
    });

    it('throws when the user does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(getUsage(USER_ID)).rejects.toThrow('User not found');
    });
  });

  describe('getUsage — Redis caching', () => {
    it('computes from the DB and populates the cache on a miss', async () => {
      mockUserTier('FREE');
      mockDbCounts(1, ['s1']);
      mockCacheGetJson.mockResolvedValue(null);

      const usage = await getUsage(USER_ID);

      expect(usage.teams.count).toBe(1);
      expect(mockPrisma.teamStaff.count).toHaveBeenCalledTimes(1);
      expect(mockCacheSetJson).toHaveBeenCalledWith(
        `usage:counts:${USER_ID}`,
        { teams: 1, seasons: 1 },
        USAGE_CACHE_TTL_SECONDS
      );
    });

    it('uses cached counts and skips the DB count queries on a hit', async () => {
      mockUserTier('FREE');
      mockCacheGetJson.mockResolvedValue({ teams: 2, seasons: 1 });

      const usage = await getUsage(USER_ID);

      expect(usage.teams.count).toBe(2);
      // teamStaff count/findMany must NOT run on a cache hit.
      expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
      expect(mockCacheSetJson).not.toHaveBeenCalled();
    });

    it('caches with a 60s TTL', () => {
      expect(USAGE_CACHE_TTL_SECONDS).toBe(60);
    });
  });

  describe('invalidateUsage', () => {
    it('deletes the user usage cache key', async () => {
      await invalidateUsage(USER_ID);

      expect(mockCacheDelete).toHaveBeenCalledWith(`usage:counts:${USER_ID}`);
    });
  });

  describe('canCreateTeam — grandfather rule', () => {
    it('allows creation when under the FREE cap', async () => {
      mockUserTier('FREE');
      mockDbCounts(2, ['s1']);

      await expect(canCreateTeam(USER_ID)).resolves.toBe(true);
    });

    it('blocks creation when exactly at the FREE cap', async () => {
      mockUserTier('FREE');
      mockDbCounts(3, ['s1']);

      await expect(canCreateTeam(USER_ID)).resolves.toBe(false);
    });

    it('grandfathers users already OVER the cap: they keep teams but cannot add more', async () => {
      // e.g. a lapsed PREMIUM user now on FREE with 5 teams.
      mockUserTier('FREE');
      mockDbCounts(5, ['s1', 's2']);

      const usage = await getUsage(USER_ID);
      // Existing teams are preserved/reported, not deleted.
      expect(usage.teams.count).toBe(5);
      // But new creation is blocked.
      await expect(canCreateTeam(USER_ID)).resolves.toBe(false);
    });

    it('always allows creation for unlimited (PREMIUM) tiers', async () => {
      mockUserTier('PREMIUM', new Date(Date.now() + 86_400_000));
      mockDbCounts(100, ['s1']);

      await expect(canCreateTeam(USER_ID)).resolves.toBe(true);
    });
  });
});
