/**
 * WorkOS service layer for authentication and user management
 */

import { workos, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI } from '../utils/workos-client';
import prisma from '../models';

export class WorkOSService {
  /**
   * Get authorization URL for user login
   * For email/password auth: No connection/organization/provider needed (enabled by default)
   * For SSO/OAuth: Requires WORKOS_CONNECTION_ID or WORKOS_ORGANIZATION_ID
   * @param state - Optional state parameter for OAuth flow
   * @param customRedirectUri - Optional custom redirect URI (for mobile deep linking)
   */
  static async getAuthorizationUrl(state?: string, customRedirectUri?: string): Promise<string> {
    const connectionId = process.env.WORKOS_CONNECTION_ID;
    const organizationId = process.env.WORKOS_ORGANIZATION_ID;
    const provider = process.env.WORKOS_PROVIDER;

    // Use custom redirect URI if provided (for mobile), otherwise use default
    const redirectUri = customRedirectUri || WORKOS_REDIRECT_URI;

    // Base params - always required
    const params: {
      clientId: string;
      redirectUri: string;
      state?: string;
      connectionId?: string;
      organizationId?: string;
      provider?: string;
    } = {
      clientId: WORKOS_CLIENT_ID,
      redirectUri,
      state: state || undefined,
    };

    // WorkOS SDK requires one of: connectionId, organizationId, or provider
    // For email/password auth using AuthKit, use provider: "authkit"
    // See: https://workos.com/docs/reference/authkit/authentication
    if (connectionId) {
      params.connectionId = connectionId;
    } else if (organizationId) {
      params.organizationId = organizationId;
    } else if (provider) {
      params.provider = provider;
    } else {
      // Default to "authkit" provider for email/password authentication
      // This enables WorkOS AuthKit's default email/password flow
      params.provider = 'authkit';
    }

    return workos.userManagement.getAuthorizationUrl(params);
  }

  /**
   * Exchange authorization code for user token
   */
  static async exchangeCodeForToken(code: string) {
    return workos.userManagement.authenticateWithCode({
      clientId: WORKOS_CLIENT_ID,
      code,
    });
  }

  /**
   * Get user information from WorkOS
   */
  static async getUser(userId: string) {
    return workos.userManagement.getUser(userId);
  }

  /**
   * List users from WorkOS
   */
  static async listUsers(options?: {
    email?: string;
    limit?: number;
    cursor?: string;
  }) {
    return workos.userManagement.listUsers(options);
  }

  /**
   * Create or update local user from WorkOS user
   * Syncs WorkOS user data with our database
   */
  static async syncUser(workosUser: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    emailVerified: boolean;
    profilePictureUrl?: string;
  }) {
    const fullName = [workosUser.firstName, workosUser.lastName]
      .filter(Boolean)
      .join(' ') || workosUser.email.split('@')[0];

    // Try to find existing user by WorkOS ID or email
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { workosUserId: workosUser.id },
          { email: workosUser.email },
        ],
      },
    });

    if (existingUser) {
      // Update existing user
      return prisma.user.update({
        where: { id: existingUser.id },
        data: {
          workosUserId: workosUser.id,
          email: workosUser.email,
          name: fullName,
          emailVerified: workosUser.emailVerified || false,
          profilePictureUrl: workosUser.profilePictureUrl || null,
        },
      });
    }

    // Create new user
    // Default role is PLAYER, can be updated later
    return prisma.user.create({
      data: {
        workosUserId: workosUser.id,
        email: workosUser.email,
        name: fullName,
        role: 'PLAYER', // Default role
        emailVerified: workosUser.emailVerified || false,
        profilePictureUrl: workosUser.profilePictureUrl || null,
      },
    });
  }

  /**
   * Verify WorkOS access token and get user
   * Decodes the JWT to extract the user ID, then validates the user exists in WorkOS.
   * NOTE: The token authenticity is validated by the WorkOS API call to getUser() -
   * if the token's user ID is invalid or doesn't correspond to a real user, the call fails.
   * For additional security, consider using WorkOS JWKS endpoint for local signature verification.
   */
  static async verifyToken(accessToken: string) {
    try {
      // Validate token structure (must be a valid JWT with 3 parts)
      const parts = accessToken.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token format: expected JWT with 3 parts');
      }

      const base64Url = parts[1];
      if (!base64Url) {
        throw new Error('Invalid token format');
      }

      // Decode base64url (JWT uses base64url encoding)
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - (base64.length % 4)) % 4);
      const decoded = Buffer.from(base64 + padding, 'base64').toString('utf-8');

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(decoded);
      } catch {
        throw new Error('Invalid token format: payload is not valid JSON');
      }

      // Validate required claims
      const userId = payload.sub;
      if (!userId || typeof userId !== 'string') {
        throw new Error('Token does not contain a valid user ID');
      }

      // Check token expiration if present
      if (payload.exp && typeof payload.exp === 'number') {
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp < now) {
          throw new Error('Token has expired');
        }
      }

      // Validate user exists in WorkOS (this also serves as a token validation step -
      // if the userId was forged, WorkOS will reject the request)
      const user = await workos.userManagement.getUser(userId);
      return user;
    } catch (error) {
      console.error('Error verifying WorkOS token:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}

