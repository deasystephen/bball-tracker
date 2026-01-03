/**
 * Authentication routes using WorkOS
 */

import { Router } from 'express';
import { WorkOSService } from '../../services/workos-service';
import { UnauthorizedError, BadRequestError } from '../../utils/errors';
import prisma from '../../models';

const router = Router();

/**
 * GET /api/v1/auth/debug (development only)
 * Debug endpoint to check WorkOS configuration
 */
if (process.env.NODE_ENV === 'development') {
  router.get('/debug', (_req, res) => {
    res.json({
      hasApiKey: !!process.env.WORKOS_API_KEY,
      apiKeyPrefix: process.env.WORKOS_API_KEY?.substring(0, 7) || 'NOT SET',
      hasClientId: !!process.env.WORKOS_CLIENT_ID,
      clientIdPrefix: process.env.WORKOS_CLIENT_ID?.substring(0, 10) || 'NOT SET',
      redirectUri: process.env.WORKOS_REDIRECT_URI || 'NOT SET',
      environment: process.env.WORKOS_ENVIRONMENT || 'NOT SET',
      connectionId: process.env.WORKOS_CONNECTION_ID || 'NOT SET',
      organizationId: process.env.WORKOS_ORGANIZATION_ID || 'NOT SET',
      provider: process.env.WORKOS_PROVIDER || 'NOT SET',
      authMethod: process.env.WORKOS_CONNECTION_ID 
        ? 'connectionId (SSO/OAuth)' 
        : process.env.WORKOS_ORGANIZATION_ID 
        ? 'organizationId (SSO)' 
        : process.env.WORKOS_PROVIDER 
        ? 'provider (OAuth)' 
        : 'email/password (default - no config needed)',
    });
  });
}

/**
 * GET /api/v1/auth/login
 * Returns WorkOS authorization URL
 * - For web browsers: redirects to the URL (default behavior)
 * - For mobile apps: returns JSON with the URL (when ?format=json or Accept: application/json)
 * - Accepts optional redirect_uri query parameter for mobile deep linking
 */
router.get('/login', async (req, res) => {
  try {
    // Allow mobile apps to specify custom redirect URI for deep linking
    const customRedirectUri = req.query.redirect_uri as string | undefined;
    const authorizationUrl = await WorkOSService.getAuthorizationUrl(undefined, customRedirectUri);
    
    // Check if client wants JSON (mobile app) or redirect (web browser)
    const wantsJson = req.query.format === 'json' || 
                     req.get('Accept')?.includes('application/json');
    
    if (wantsJson) {
      // Return JSON for mobile apps
      res.json({ url: authorizationUrl });
    } else {
      // Redirect for web browsers
      res.redirect(authorizationUrl);
    }
  } catch (error) {
    console.error('Error generating authorization URL:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to generate authorization URL',
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
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

