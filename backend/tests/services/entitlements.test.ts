/**
 * Unit tests for the canonical entitlements source of truth
 * (src/services/entitlements): feature->tier map, usage limits, team cap.
 */

import {
  Feature,
  FREE_TEAM_LIMIT,
  hasFeature,
  getUsageLimits,
  getRequiredTier,
  getEffectiveTier,
  isSubscriptionActive,
  canCreateTeam,
  getAllFeatures,
} from '../../src/services/entitlements';

describe('entitlements service (source of truth)', () => {
  it('FREE tier has no gated features', () => {
    for (const f of Object.values(Feature)) {
      expect(hasFeature('FREE', f)).toBe(false);
    }
  });

  it('PREMIUM unlocks premium features but not league features', () => {
    expect(hasFeature('PREMIUM', Feature.STATS_EXPORT)).toBe(true);
    expect(hasFeature('PREMIUM', Feature.CALENDAR_SYNC)).toBe(true);
    expect(hasFeature('PREMIUM', Feature.UNLIMITED_TEAMS)).toBe(true);
    expect(hasFeature('PREMIUM', Feature.TOURNAMENT_BRACKETS)).toBe(false);
    expect(hasFeature('PREMIUM', Feature.MASTER_CALENDAR)).toBe(false);
  });

  it('LEAGUE unlocks everything (premium + league)', () => {
    for (const f of Object.values(Feature)) {
      expect(hasFeature('LEAGUE', f)).toBe(true);
    }
  });

  it('getRequiredTier maps features to their minimum tier', () => {
    expect(getRequiredTier(Feature.STATS_EXPORT)).toBe('PREMIUM');
    expect(getRequiredTier(Feature.UNLIMITED_TEAMS)).toBe('PREMIUM');
    expect(getRequiredTier(Feature.TOURNAMENT_BRACKETS)).toBe('LEAGUE');
  });

  it('exposes a documented FREE_TEAM_LIMIT of 3 used by usage limits', () => {
    expect(FREE_TEAM_LIMIT).toBe(3);
    expect(getUsageLimits('FREE').maxTeams).toBe(3);
    expect(getUsageLimits('PREMIUM').maxTeams).toBe(Infinity);
    expect(getUsageLimits('LEAGUE').maxTeams).toBe(Infinity);
  });

  it('canCreateTeam enforces the cap at create time (grandfather semantics)', () => {
    expect(canCreateTeam('FREE', 0)).toBe(true);
    expect(canCreateTeam('FREE', 2)).toBe(true);
    expect(canCreateTeam('FREE', 3)).toBe(false); // at cap
    expect(canCreateTeam('FREE', 9)).toBe(false); // grandfathered over-cap: no new creates
    expect(canCreateTeam('PREMIUM', 100)).toBe(true);
    expect(canCreateTeam('LEAGUE', 100)).toBe(true);
  });

  it('expired paid subscriptions resolve to an effective FREE tier', () => {
    const expired = { subscriptionTier: 'PREMIUM' as const, subscriptionExpiresAt: new Date('2000-01-01') };
    expect(isSubscriptionActive(expired)).toBe(false);
    expect(getEffectiveTier(expired)).toBe('FREE');

    const active = { subscriptionTier: 'PREMIUM' as const, subscriptionExpiresAt: new Date(Date.now() + 86_400_000) };
    expect(getEffectiveTier(active)).toBe('PREMIUM');

    const free = { subscriptionTier: 'FREE' as const, subscriptionExpiresAt: null };
    expect(isSubscriptionActive(free)).toBe(true);
  });

  it('getAllFeatures returns availability for every feature', () => {
    const free = getAllFeatures('FREE');
    expect(Object.keys(free).length).toBe(Object.values(Feature).length);
    expect(Object.values(free).every((v) => v === false)).toBe(true);
  });
});
