/**
 * Authentication middleware for protecting routes
 */

import { Request, Response, NextFunction } from 'express';
import { WorkOSService } from '../../services/workos-service';
import { UnauthorizedError, ForbiddenError } from '../../utils/errors';
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
        email: string;
        name: string;
        role: string;
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

