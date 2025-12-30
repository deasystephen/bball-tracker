/**
 * WorkOS service layer for authentication and user management
 */

import { workos, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI } from '../utils/workos-client';
import prisma from '../models';

export class WorkOSService {
  /**
   * Get authorization URL for user login
   */
  static async getAuthorizationUrl(state?: string): Promise<string> {
    return workos.userManagement.getAuthorizationUrl({
      clientId: WORKOS_CLIENT_ID,
      redirectUri: WORKOS_REDIRECT_URI,
      state: state || undefined,
    });
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

