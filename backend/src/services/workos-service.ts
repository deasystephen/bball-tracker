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
   * The access token is used as the user ID in WorkOS API
   */
  static async verifyToken(accessToken: string) {
    try {
      // WorkOS access tokens can be used to get user info
      // The token itself contains user information
      const user = await workos.userManagement.getUser(accessToken);
      return user;
    } catch (error) {
      console.error('Error verifying WorkOS token:', error);
      return null;
    }
  }
}

