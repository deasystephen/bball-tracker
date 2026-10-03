/**
 * Entitlement-enforcement middleware.
 *
 * `requireEntitlement(feature)` gates a route behind a subscription feature.
 * `requireTeamCreateLimit()` enforces a tier's team-count cap at create time
 * (with grandfathering -- see `src/services/entitlements`). No tier has a
 * finite cap today (#445), so it currently lets every caller through.
 *
 * Both read the canonical feature->tier map / limits from the single source of
 * truth in `src/services/entitlements`. On denial they respond with HTTP 402
 * Payment Required and a machine-readable upgrade hint:
 *
 *   { code: 'upgrade_required', feature, currentTier, requiredTier }
 *
 * System admins (role 'ADMIN') bypass all entitlement checks.
 */

import { Request, Response, NextFunction } from 'express';
import { SubscriptionTier } from '@prisma/client';
import {
  Feature,
  EntitlementUser,
  hasFeature,
  getEffectiveTier,
  getRequiredTier,
  getUsageLimits,
  canCreateTeam,
  featureCode,
} from '../../services/entitlements';
import { PaymentRequiredError, UnauthorizedError } from '../../utils/errors';
import { countDistinctStaffTeams } from '../../utils/permissions';
import { logger } from '../../utils/logger';

const PAYMENT_REQUIRED = 402;

/**
 * Answer 402 and log the denial (#617). Logged at info with ids only: a
 * denial is an expected product outcome, not an error, but it is the one
 * signal that a tier cap is biting a real user.
 */
function denyUpgradeRequired(
  req: Request,
  res: Response,
  details: { feature: string; currentTier: SubscriptionTier; requiredTier: SubscriptionTier }
): void {
  logger.info('Entitlement denied', {
    userId: req.user?.id,
    feature: details.feature,
    currentTier: details.currentTier,
    requiredTier: details.requiredTier,
    statusCode: PAYMENT_REQUIRED,
  });
  res.status(PAYMENT_REQUIRED).json(new PaymentRequiredError(details).body());
}

/**
 * Resolve the effective tier for the authenticated request user. A user that
 * predates the subscription columns (or a test stub) without an explicit tier
 * is treated as FREE.
 */
function effectiveTierFor(user: Express.Request['user']): SubscriptionTier {
  const entitlementUser: EntitlementUser = {
    subscriptionTier: user?.subscriptionTier ?? 'FREE',
    subscriptionExpiresAt: user?.subscriptionExpiresAt ?? null,
  };
  return getEffectiveTier(entitlementUser);
}

/**
 * Gate a route behind a subscription feature. FREE users (and expired paid
 * users) are blocked with 402 unless their effective tier entitles the feature.
 */
export function requireEntitlement(feature: Feature) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    // System admins bypass entitlement checks.
    if (req.user.role === 'ADMIN') {
      return next();
    }

    const currentTier = effectiveTierFor(req.user);
    if (hasFeature(currentTier, feature)) {
      return next();
    }

    denyUpgradeRequired(req, res, {
      feature: featureCode(feature),
      currentTier,
      requiredTier: getRequiredTier(feature),
    });
  };
}

/**
 * Enforce the caller's tier team-creation cap, when that tier has one.
 *
 * Every tier is unlimited since #445, so today this always calls `next()`
 * without a count query. It stays mounted so that a finite `maxTeams` in
 * `USAGE_LIMITS` is enforced again with no other change.
 *
 * The limit is checked ONLY here, at create time: a user is blocked when their
 * current staff team count already meets/exceeds their tier's cap. Users who
 * are already over the cap keep their existing teams (grandfathered) -- they
 * are simply prevented from creating more until they drop back under it or
 * upgrade.
 */
export function requireTeamCreateLimit() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    // System admins bypass usage limits.
    if (req.user.role === 'ADMIN') {
      return next();
    }

    const currentTier = effectiveTierFor(req.user);

    // Unlimited tiers (all of them today) skip the count query entirely.
    if (getUsageLimits(currentTier).maxTeams === Infinity) {
      return next();
    }

    const teamCount = await countDistinctStaffTeams(req.user.id);

    if (canCreateTeam(currentTier, teamCount)) {
      return next();
    }

    denyUpgradeRequired(req, res, {
      feature: featureCode(Feature.UNLIMITED_TEAMS),
      currentTier,
      requiredTier: getRequiredTier(Feature.UNLIMITED_TEAMS),
    });
  };
}
