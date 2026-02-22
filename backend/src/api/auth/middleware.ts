/**
 * Authentication middleware for protecting routes
 */

import { Request, Response, NextFunction } from 'express';
import { SubscriptionTier } from '@prisma/client';
import { WorkOSService } from '../../services/workos-service';
import { UnauthorizedError, ForbiddenError } from '../../utils/errors';
import { Feature, hasFeature, getEffectiveTier, getRequiredTier, getUsageLimits } from '../../utils/entitlements';
import prisma from '../../models';

/**
 * Extend Express Request to include user
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string | null;
        name: string;
        role: string;
        subscriptionTier: SubscriptionTier;
        subscriptionExpiresAt: Date | null;
      };
    }
  }
}

/**
 * Middleware to verify WorkOS access token and attach user to request
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authorization token required');
    }

    const token = authHeader.substring(7);

    // Check for dev token (development only)
    if (process.env.NODE_ENV === 'development' && token.startsWith('dev_')) {
      const devTokenData = token.substring(4);
      try {
        const decoded = JSON.parse(Buffer.from(devTokenData, 'base64').toString());

        // Check expiration
        if (decoded.exp < Date.now()) {
          throw new UnauthorizedError('Dev token expired');
        }

        // Get user from database
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            subscriptionTier: true,
            subscriptionExpiresAt: true,
          },
        });

        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        req.user = user;
        return next();
      } catch (e) {
        throw new UnauthorizedError('Invalid dev token');
      }
    }

    // Verify token with WorkOS
    const workosUser = await WorkOSService.verifyToken(token);

    if (!workosUser) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Get user from our database
    const user = await prisma.user.findUnique({
      where: { workosUserId: workosUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        subscriptionTier: true,
        subscriptionExpiresAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to check if user has required role
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError('Insufficient permissions'));
    }

    next();
  };
}

/**
 * Middleware to check if user's subscription tier grants access to a feature.
 * System admins bypass all entitlement checks.
 */
export function requireFeature(feature: Feature) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    // System admins bypass entitlement checks
    if (req.user.role === 'ADMIN') {
      return next();
    }

    const tier = getEffectiveTier(req.user);
    if (!hasFeature(tier, feature)) {
      const requiredTier = getRequiredTier(feature);
      res.status(403).json({
        error: 'upgrade_required',
        message: `This feature requires a ${requiredTier} subscription`,
        requiredTier,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to enforce usage limits (e.g., max teams for Free tier).
 * System admins bypass usage limit checks.
 */
export function requireUsageLimit(resource: 'teams') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    // System admins bypass usage limits
    if (req.user.role === 'ADMIN') {
      return next();
    }

    const tier = getEffectiveTier(req.user);
    const limits = getUsageLimits(tier);

    if (resource === 'teams' && limits.maxTeams !== Infinity) {
      const teamCount = await prisma.teamStaff.count({
        where: { userId: req.user.id },
      });

      if (teamCount >= limits.maxTeams) {
        res.status(403).json({
          error: 'usage_limit_reached',
          message: `Free plan is limited to ${limits.maxTeams} teams. Upgrade to Premium for unlimited teams.`,
          limit: limits.maxTeams,
          current: teamCount,
          requiredTier: 'PREMIUM',
        });
        return;
      }
    }

    next();
  };
}

