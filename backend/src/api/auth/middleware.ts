/**
 * Authentication middleware for protecting routes
 */

import { Request, Response, NextFunction } from 'express';
import { WorkOSService } from '../../services/workos-service';
import { UnauthorizedError } from '../../utils/errors';
import prisma from '../../models';

/**
 * Extend Express Request to include user
 */
declare global {
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
      return next(new UnauthorizedError('Insufficient permissions'));
    }

    next();
  };
}

