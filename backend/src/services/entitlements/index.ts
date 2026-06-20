/**
 * Entitlements: SINGLE SOURCE OF TRUTH for subscription feature gating.
 *
 * This module is the one authoritative place that maps subscription tiers
 * (FREE, PREMIUM, LEAGUE) to the features and usage limits they unlock. All
 * entitlement enforcement (API middleware, services, future usage metering in
 * issue #43) MUST read from here rather than re-deriving the tier rules. Do not
 * scatter feature->tier knowledge across the codebase.
 *
 * ---------------------------------------------------------------------------
 * Feature -> required-tier map (canonical):
 *
 *   Feature                | Minimum tier
 *   -----------------------|-------------
 *   UNLIMITED_TEAMS        | PREMIUM
 *   FULL_SEASON_HISTORY    | PREMIUM
 *   CALENDAR_SYNC          | PREMIUM
 *   STATS_EXPORT           | PREMIUM
 *   ADVANCED_STATS         | PREMIUM
 *   PRACTICE_SCHEDULING    | PREMIUM
 *   AD_FREE                | PREMIUM
 *   REGISTRATION_PAYMENTS  | LEAGUE
 *   TOURNAMENT_BRACKETS    | LEAGUE
 *   ORG_MESSAGING          | LEAGUE
 *   FINANCIAL_REPORTING    | LEAGUE
 *   MASTER_CALENDAR        | LEAGUE
 *
 * ---------------------------------------------------------------------------
 * FREE-tier team limit & GRANDFATHER decision:
 *
 *   FREE users may belong to at most FREE_TEAM_LIMIT (3) teams as staff.
 *   This limit is enforced ONLY at create time: a FREE user is blocked from
 *   creating a new team when their current staff team count is already >= 3.
 *
 *   GRANDFATHERING: users who are already over the limit (e.g. they were on a
 *   paid tier, created many teams, then downgraded; or the limit was lowered)
 *   KEEP all of their existing teams. We never delete or hide teams. They
 *   simply cannot create additional teams until they are back under the limit
 *   or upgrade to PREMIUM/LEAGUE (which removes the cap entirely).
 *
 * Out of scope here (owned by issue #43): broader usage metering. This file
 * intentionally exposes only the constants/map #43 can reuse.
 */

import { SubscriptionTier } from '@prisma/client';

/**
 * All gated product features. The enum VALUES are the stable UPPER_SNAKE
 * identifiers exposed by GET /auth/entitlements (`getAllFeatures` keys). The
 * 402 upgrade-hint payload emits the lowercased form (see `featureCode`).
 */
export enum Feature {
  // Usage limits / volume
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

/**
 * Maximum number of teams a FREE-tier user may be staff on.
 * Shared constant so usage-metering work (#43) reuses the same number.
 */
export const FREE_TEAM_LIMIT = 3;

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

/**
 * Canonical tier -> entitled-features map.
 */
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
  FREE: { maxTeams: FREE_TEAM_LIMIT, maxSeasons: 1 },
  PREMIUM: { maxTeams: Infinity, maxSeasons: Infinity },
  LEAGUE: { maxTeams: Infinity, maxSeasons: Infinity },
};

/**
 * Subset of the user record needed to evaluate entitlements.
 */
export interface EntitlementUser {
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt: Date | null;
}

/**
 * Check if a subscription tier grants access to a feature.
 */
export function hasFeature(tier: SubscriptionTier, feature: Feature): boolean {
  return TIER_ENTITLEMENTS[tier].has(feature);
}

/**
 * Get usage limits for a subscription tier.
 */
export function getUsageLimits(tier: SubscriptionTier): UsageLimits {
  return USAGE_LIMITS[tier];
}

/**
 * Check if a user's subscription is currently active.
 * FREE tier is always active. Paid tiers require a non-expired expiration date.
 */
export function isSubscriptionActive(user: EntitlementUser): boolean {
  if (user.subscriptionTier === 'FREE') return true;
  if (!user.subscriptionExpiresAt) return false;
  return user.subscriptionExpiresAt > new Date();
}

/**
 * Get the effective tier for a user, accounting for subscription expiration.
 * An expired paid subscription is treated as FREE.
 */
export function getEffectiveTier(user: EntitlementUser): SubscriptionTier {
  return isSubscriptionActive(user) ? user.subscriptionTier : 'FREE';
}

/**
 * Get the minimum tier required for a feature.
 */
export function getRequiredTier(feature: Feature): SubscriptionTier {
  if (TIER_ENTITLEMENTS.PREMIUM.has(feature)) return 'PREMIUM';
  if (TIER_ENTITLEMENTS.LEAGUE.has(feature)) return 'LEAGUE';
  return 'FREE';
}

/**
 * Get all features and their availability for a given tier.
 */
export function getAllFeatures(tier: SubscriptionTier): Record<Feature, boolean> {
  const result = {} as Record<Feature, boolean>;
  for (const feature of Object.values(Feature)) {
    result[feature] = hasFeature(tier, feature);
  }
  return result;
}

/**
 * Whether a user at `tier` is allowed to create another team given how many
 * teams they currently staff. Enforced at create time only (grandfathering).
 */
export function canCreateTeam(tier: SubscriptionTier, currentTeamCount: number): boolean {
  return currentTeamCount < getUsageLimits(tier).maxTeams;
}

/**
 * The stable snake_case identifier for a feature, used in API payloads / paywall
 * hints (e.g. the 402 upgrade-required body). Derived from the enum value so it
 * stays in sync with the single source of truth.
 */
export function featureCode(feature: Feature): string {
  return feature.toLowerCase();
}
