/**
 * Authentication middleware for protecting routes
 */

import { Request, Response, NextFunction } from 'express';
import { SubscriptionTier } from '@prisma/client';
import { WorkOSService } from '../../services/workos-service';
import { UnauthorizedError } from '../../utils/errors';
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
        // Dev tokens resolve by id, so a deleted account (#444) must be
        // refused explicitly here — the WorkOS branch below gets that for free
        // because deletion nulls `workosUserId`.
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId, deletedAt: null },
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
      } catch (_e) {
        throw new UnauthorizedError('Invalid dev token');
      }
    }

    // Verify token with WorkOS
    const workosUser = await WorkOSService.verifyToken(token);

    if (!workosUser) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Get user from our database
    // A deleted account has `workosUserId = null` (#444), so the old token's
    // `sub` never matches again; `deletedAt: null` is belt and braces.
    const user = await prisma.user.findUnique({
      where: { workosUserId: workosUser.id, deletedAt: null },
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

// `requireRole`, `requireFeature` and `requireUsageLimit` used to live here but
// were never mounted on a route. They contradicted the real contracts —
// role-based gating is done per-team/league in the services (never on the
// self-selected global role), and subscription gating returns 402 via
// `api/middleware/entitlements.ts` (`requireEntitlement` /
// `requireTeamCreateLimit`). Removed in the authz hardening PR (role matrix
// B2.2); do not reintroduce.

