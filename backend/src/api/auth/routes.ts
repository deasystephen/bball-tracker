/**
 * Authentication routes using WorkOS
 */

import { Router } from 'express';
import { WorkOSService } from '../../services/workos-service';
import { UnauthorizedError, BadRequestError } from '../../utils/errors';
import prisma from '../../models';

const router = Router();

/**
 * GET /api/v1/auth/login
 * Redirects to WorkOS authorization URL
 */
router.get('/login', async (_req, res) => {
  try {
    const authorizationUrl = await WorkOSService.getAuthorizationUrl();
    res.redirect(authorizationUrl);
  } catch (error) {
    console.error('Error generating authorization URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

/**
 * GET /api/v1/auth/callback
 * Handles WorkOS OAuth callback
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      throw new BadRequestError(`Authentication error: ${error}`);
    }

    if (!code || typeof code !== 'string') {
      throw new BadRequestError('Authorization code is required');
    }

    // Exchange code for token
    const { user: workosUser, accessToken } = await WorkOSService.exchangeCodeForToken(code);

    // Sync user to our database
    const user = await WorkOSService.syncUser({
      id: workosUser.id,
      email: workosUser.email,
      firstName: workosUser.firstName ?? undefined,
      lastName: workosUser.lastName ?? undefined,
      emailVerified: workosUser.emailVerified,
      profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
    });

    // In production, you'd set this as an HTTP-only cookie or return it securely
    // For now, return user info and token (mobile app will handle token storage)
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      accessToken, // Mobile app will store this securely
    });
  } catch (error) {
    console.error('Error in auth callback:', error);
    if (error instanceof BadRequestError) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
});

/**
 * GET /api/v1/auth/me
 * Get current user information
 * Requires: Authorization header with Bearer token
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authorization token required');
    }

    const token = authHeader.substring(7);
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
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error('Error getting user:', error);
    if (error instanceof UnauthorizedError) {
      res.status(401).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get user information' });
    }
  }
});

export default router;

