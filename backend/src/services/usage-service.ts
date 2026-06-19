/**
 * Usage metering service.
 *
 * Provides a single place to answer "how much of each metered feature has this
 * user consumed, and what is their tier limit?". Used both to ENFORCE limits
 * (e.g. block FREE-tier team creation past the cap) and to SURFACE usage to the
 * client so upgrade CTAs are accurate ("2 of 3 teams used").
 *
 * Design decisions:
 * - Counts are derived from existing data at read time (no separate counter
 *   table to drift out of sync). A user's "team count" = the number of teams
 *   they are staff on (`teamStaff.count({ where: { userId } })`).
 * - Counts are cached in Redis with a short TTL (USAGE_CACHE_TTL_SECONDS) to
 *   absorb repeated reads, and explicitly invalidated on relevant writes
 *   (e.g. team create / delete). The cache is best-effort — a Redis outage
 *   only costs an extra DB query, never correctness.
 * - The team-limit value itself is single-sourced from `utils/entitlements`
 *   (`getUsageLimits`), shared with the entitlements/feature-flag layer.
 *
 * GRANDFATHER RULE:
 *   Enforcement counts CURRENT usage against the limit at create time. A user
 *   who already has more teams than the limit when enforcement ships (e.g. a
 *   former PREMIUM user who lapsed to FREE with 5 teams) KEEPS all existing
 *   teams — we never delete or hide them. They simply cannot CREATE new teams
 *   until they are back under the limit (or upgrade). This falls out naturally
 *   from a `count >= limit` check rather than `count + 1 > limit`, and is
 *   verified by tests (see tests/services/usage-service.test.ts and
 *   tests/api/usage.test.ts).
 *
 * Metered features (see `MeteredFeature`):
 *   - teams: number of teams the user is staff on, vs tier `maxTeams`.
 *   - seasons: number of distinct seasons across the user's teams, vs
 *     tier `maxSeasons`.
 * Out of scope (per issue #43): per-day/per-hour rate limits, usage-based
 * pricing, admin usage dashboards.
 */

import { SubscriptionTier } from '@prisma/client';
import prisma from '../models';
import { getEffectiveTier, getUsageLimits } from '../utils/entitlements';
import { cacheGetJson, cacheSetJson, cacheDelete } from '../utils/redis';

/** TTL for cached usage counts, in seconds. */
export const USAGE_CACHE_TTL_SECONDS = 60;

/** The set of metered features exposed by `getUsage`. */
export type MeteredFeature = 'teams' | 'seasons';

/** A single metered metric: how many consumed vs the tier limit. */
export interface UsageMetric {
  count: number;
  /**
   * The tier limit. `null` means unlimited (the paid-tier `Infinity` limit is
   * normalized to `null` so it serializes cleanly to JSON).
   */
  limit: number | null;
  /** Whether the user is at or over the limit (i.e. cannot add more). */
  limitReached: boolean;
}

/** Full usage payload for a user, keyed by metered feature. */
export interface Usage {
  tier: SubscriptionTier;
  teams: UsageMetric;
  seasons: UsageMetric;
}

/** Raw counts cached in Redis (limits are derived from the tier at read time). */
interface CachedCounts {
  teams: number;
  seasons: number;
}

function usageCacheKey(userId: string): string {
  return `usage:counts:${userId}`;
}

/** Normalize an `Infinity` limit to `null` for clean JSON serialization. */
function normalizeLimit(limit: number): number | null {
  return Number.isFinite(limit) ? limit : null;
}

/** Build a UsageMetric from a raw count and a (possibly Infinity) limit. */
function toMetric(count: number, limit: number): UsageMetric {
  return {
    count,
    limit: normalizeLimit(limit),
    limitReached: Number.isFinite(limit) ? count >= limit : false,
  };
}

/**
 * Compute raw usage counts for a user directly from the database.
 * Exported for testing; prefer `getUsage` for normal use (it adds caching).
 */
export async function computeCounts(userId: string): Promise<CachedCounts> {
  const [teams, teamSeasons] = await Promise.all([
    prisma.teamStaff.count({ where: { userId } }),
    // Distinct seasons across the teams the user is staff on.
    prisma.teamStaff.findMany({
      where: { userId },
      select: { team: { select: { seasonId: true } } },
    }),
  ]);

  const distinctSeasons = new Set(teamSeasons.map((s) => s.team.seasonId));

  return { teams, seasons: distinctSeasons.size };
}

/**
 * Get a user's current usage vs their tier limits for every metered feature.
 * Reads cached counts from Redis when available (TTL 60s); otherwise computes
 * from the DB and populates the cache.
 */
export async function getUsage(userId: string): Promise<Usage> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionTier: true, subscriptionExpiresAt: true },
  });

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  const tier = getEffectiveTier(user);
  const limits = getUsageLimits(tier);

  const cacheKey = usageCacheKey(userId);
  let counts = await cacheGetJson<CachedCounts>(cacheKey);

  if (!counts) {
    counts = await computeCounts(userId);
    await cacheSetJson(cacheKey, counts, USAGE_CACHE_TTL_SECONDS);
  }

  return {
    tier,
    teams: toMetric(counts.teams, limits.maxTeams),
    seasons: toMetric(counts.seasons, limits.maxSeasons),
  };
}

/**
 * Invalidate a user's cached usage counts. Call after any write that changes a
 * metered count (e.g. team create/delete) so the next read recomputes.
 */
export async function invalidateUsage(userId: string): Promise<void> {
  await cacheDelete(usageCacheKey(userId));
}

/**
 * Whether a user is allowed to create another team under their tier limit.
 *
 * Implements the grandfather rule: returns `false` only when the user is AT or
 * OVER the limit, so users already over the cap keep their teams but cannot add
 * more. Returns `true` for tiers with an unlimited (`Infinity`) team allowance.
 */
export async function canCreateTeam(userId: string): Promise<boolean> {
  const usage = await getUsage(userId);
  return !usage.teams.limitReached;
}
