/**
 * Feature entitlements and usage limits by subscription tier
 */

import { SubscriptionTier } from '@prisma/client';

export enum Feature {
  // Usage limits
  UNLIMITED_TEAMS = 'UNLIMITED_TEAMS',
  FULL_SEASON_HISTORY = 'FULL_SEASON_HISTORY',

  // Premium features
  CALENDAR_SYNC = 'CALENDAR_SYNC',
  STATS_EXPORT = 'STATS_EXPORT',
  ADVANCED_STATS = 'ADVANCED_STATS',
  PRACTICE_SCHEDULING = 'PRACTICE_SCHEDULING',
  AD_FREE = 'AD_FREE',

  // League features
  REGISTRATION_PAYMENTS = 'REGISTRATION_PAYMENTS',
  TOURNAMENT_BRACKETS = 'TOURNAMENT_BRACKETS',
  ORG_MESSAGING = 'ORG_MESSAGING',
  FINANCIAL_REPORTING = 'FINANCIAL_REPORTING',
  MASTER_CALENDAR = 'MASTER_CALENDAR',
}

const PREMIUM_FEATURES = new Set<Feature>([
  Feature.UNLIMITED_TEAMS,
  Feature.FULL_SEASON_HISTORY,
  Feature.CALENDAR_SYNC,
  Feature.STATS_EXPORT,
  Feature.ADVANCED_STATS,
  Feature.PRACTICE_SCHEDULING,
  Feature.AD_FREE,
]);

const LEAGUE_FEATURES = new Set<Feature>([
  ...PREMIUM_FEATURES,
  Feature.REGISTRATION_PAYMENTS,
  Feature.TOURNAMENT_BRACKETS,
  Feature.ORG_MESSAGING,
  Feature.FINANCIAL_REPORTING,
  Feature.MASTER_CALENDAR,
]);

const TIER_ENTITLEMENTS: Record<SubscriptionTier, Set<Feature>> = {
  FREE: new Set<Feature>(),
  PREMIUM: PREMIUM_FEATURES,
  LEAGUE: LEAGUE_FEATURES,
};

export interface UsageLimits {
  maxTeams: number;
  maxSeasons: number;
}

const USAGE_LIMITS: Record<SubscriptionTier, UsageLimits> = {
  FREE: { maxTeams: 3, maxSeasons: 1 },
  PREMIUM: { maxTeams: Infinity, maxSeasons: Infinity },
  LEAGUE: { maxTeams: Infinity, maxSeasons: Infinity },
};

/**
 * Check if a subscription tier grants access to a feature
 */
export function hasFeature(tier: SubscriptionTier, feature: Feature): boolean {
  return TIER_ENTITLEMENTS[tier].has(feature);
}

/**
 * Get usage limits for a subscription tier
 */
export function getUsageLimits(tier: SubscriptionTier): UsageLimits {
  return USAGE_LIMITS[tier];
}

/**
 * Check if a user's subscription is currently active
 * FREE tier is always active. Paid tiers require a non-expired expiration date.
 */
export function isSubscriptionActive(user: {
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt: Date | null;
}): boolean {
  if (user.subscriptionTier === 'FREE') return true;
  if (!user.subscriptionExpiresAt) return false;
  return user.subscriptionExpiresAt > new Date();
}

/**
 * Get the effective tier for a user, accounting for subscription expiration
 */
export function getEffectiveTier(user: {
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt: Date | null;
}): SubscriptionTier {
  return isSubscriptionActive(user) ? user.subscriptionTier : 'FREE';
}

/**
 * Get the minimum tier required for a feature
 */
export function getRequiredTier(feature: Feature): SubscriptionTier {
  if (TIER_ENTITLEMENTS.PREMIUM.has(feature)) return 'PREMIUM';
  if (TIER_ENTITLEMENTS.LEAGUE.has(feature)) return 'LEAGUE';
  return 'FREE';
}

/**
 * Get all features and their availability for a given tier
 */
export function getAllFeatures(tier: SubscriptionTier): Record<Feature, boolean> {
  const result = {} as Record<Feature, boolean>;
  for (const feature of Object.values(Feature)) {
    result[feature] = hasFeature(tier, feature);
  }
  return result;
}
