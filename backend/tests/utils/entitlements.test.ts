/**
 * Unit tests for entitlements utility
 */

import {
  Feature,
  hasFeature,
  getUsageLimits,
  isSubscriptionActive,
  getEffectiveTier,
  getRequiredTier,
  getAllFeatures,
} from '../../src/utils/entitlements';

describe('Entitlements', () => {
  describe('hasFeature', () => {
    it('should return false for all features on FREE tier', () => {
      for (const feature of Object.values(Feature)) {
        expect(hasFeature('FREE', feature)).toBe(false);
      }
    });

    it('should return true for premium features on PREMIUM tier', () => {
      expect(hasFeature('PREMIUM', Feature.UNLIMITED_TEAMS)).toBe(true);
      expect(hasFeature('PREMIUM', Feature.FULL_SEASON_HISTORY)).toBe(true);
      expect(hasFeature('PREMIUM', Feature.CALENDAR_SYNC)).toBe(true);
      expect(hasFeature('PREMIUM', Feature.STATS_EXPORT)).toBe(true);
      expect(hasFeature('PREMIUM', Feature.ADVANCED_STATS)).toBe(true);
      expect(hasFeature('PREMIUM', Feature.PRACTICE_SCHEDULING)).toBe(true);
      expect(hasFeature('PREMIUM', Feature.AD_FREE)).toBe(true);
    });

    it('should return false for league features on PREMIUM tier', () => {
      expect(hasFeature('PREMIUM', Feature.REGISTRATION_PAYMENTS)).toBe(false);
      expect(hasFeature('PREMIUM', Feature.TOURNAMENT_BRACKETS)).toBe(false);
      expect(hasFeature('PREMIUM', Feature.ORG_MESSAGING)).toBe(false);
      expect(hasFeature('PREMIUM', Feature.FINANCIAL_REPORTING)).toBe(false);
      expect(hasFeature('PREMIUM', Feature.MASTER_CALENDAR)).toBe(false);
    });

    it('should return true for all features on LEAGUE tier', () => {
      for (const feature of Object.values(Feature)) {
        expect(hasFeature('LEAGUE', feature)).toBe(true);
      }
    });
  });

  describe('getUsageLimits', () => {
    it('should return limited teams for FREE tier', () => {
      const limits = getUsageLimits('FREE');
      expect(limits.maxTeams).toBe(3);
      expect(limits.maxSeasons).toBe(1);
    });

    it('should return unlimited for PREMIUM tier', () => {
      const limits = getUsageLimits('PREMIUM');
      expect(limits.maxTeams).toBe(Infinity);
      expect(limits.maxSeasons).toBe(Infinity);
    });

    it('should return unlimited for LEAGUE tier', () => {
      const limits = getUsageLimits('LEAGUE');
      expect(limits.maxTeams).toBe(Infinity);
      expect(limits.maxSeasons).toBe(Infinity);
    });
  });

  describe('isSubscriptionActive', () => {
    it('should return true for FREE tier regardless of expiration', () => {
      expect(isSubscriptionActive({ subscriptionTier: 'FREE', subscriptionExpiresAt: null })).toBe(true);
      expect(isSubscriptionActive({ subscriptionTier: 'FREE', subscriptionExpiresAt: new Date('2020-01-01') })).toBe(true);
    });

    it('should return false for paid tier with null expiration', () => {
      expect(isSubscriptionActive({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: null })).toBe(false);
      expect(isSubscriptionActive({ subscriptionTier: 'LEAGUE', subscriptionExpiresAt: null })).toBe(false);
    });

    it('should return true for paid tier with future expiration', () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      expect(isSubscriptionActive({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: future })).toBe(true);
    });

    it('should return false for paid tier with past expiration', () => {
      const past = new Date('2020-01-01');
      expect(isSubscriptionActive({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: past })).toBe(false);
    });
  });

  describe('getEffectiveTier', () => {
    it('should return FREE for free users', () => {
      expect(getEffectiveTier({ subscriptionTier: 'FREE', subscriptionExpiresAt: null })).toBe('FREE');
    });

    it('should return PREMIUM for active premium users', () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      expect(getEffectiveTier({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: future })).toBe('PREMIUM');
    });

    it('should return FREE for expired premium users', () => {
      const past = new Date('2020-01-01');
      expect(getEffectiveTier({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: past })).toBe('FREE');
    });
  });

  describe('getRequiredTier', () => {
    it('should return PREMIUM for premium features', () => {
      expect(getRequiredTier(Feature.STATS_EXPORT)).toBe('PREMIUM');
      expect(getRequiredTier(Feature.AD_FREE)).toBe('PREMIUM');
      expect(getRequiredTier(Feature.UNLIMITED_TEAMS)).toBe('PREMIUM');
    });

    it('should return LEAGUE for league-only features', () => {
      expect(getRequiredTier(Feature.REGISTRATION_PAYMENTS)).toBe('LEAGUE');
      expect(getRequiredTier(Feature.TOURNAMENT_BRACKETS)).toBe('LEAGUE');
      expect(getRequiredTier(Feature.ORG_MESSAGING)).toBe('LEAGUE');
    });
  });

  describe('getAllFeatures', () => {
    it('should return all features as false for FREE tier', () => {
      const features = getAllFeatures('FREE');
      expect(Object.values(features).every((v) => v === false)).toBe(true);
    });

    it('should return correct features for PREMIUM tier', () => {
      const features = getAllFeatures('PREMIUM');
      expect(features[Feature.STATS_EXPORT]).toBe(true);
      expect(features[Feature.REGISTRATION_PAYMENTS]).toBe(false);
    });

    it('should return all features as true for LEAGUE tier', () => {
      const features = getAllFeatures('LEAGUE');
      expect(Object.values(features).every((v) => v === true)).toBe(true);
    });
  });
});
