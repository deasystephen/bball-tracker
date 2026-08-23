/**
 * WorkOS service layer for authentication and user management
 */

import { jwtVerify, decodeProtectedHeader, errors as joseErrors } from 'jose';
import { workos, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI, WORKOS_JWT_ISSUER, getWorkOSJwks } from '../utils/workos-client';
import { Prisma, User } from '@prisma/client';
import prisma from '../models';
import { logger } from '../utils/logger';
import { isAdminEmail } from '../utils/admin-emails';
import { ConflictError, ServiceUnavailableError } from '../utils/errors';

type UserManagement = typeof workos.userManagement;
export type WorkOSAuthentication = Awaited<ReturnType<UserManagement['authenticateWithCode']>>;
export type WorkOSUser = Awaited<ReturnType<UserManagement['getUser']>>;
export type WorkOSUserList = Awaited<ReturnType<UserManagement['listUsers']>>;

/** Signature algorithms WorkOS uses for access tokens. Anything else is rejected outright. */
const ALLOWED_JWT_ALGS = ['RS256', 'ES256'];

/** Claims we rely on from a verified WorkOS access token. `id` is the WorkOS user id (`sub`). */
export interface VerifiedToken {
  id: string;
  sessionId?: string;
  expiresAt: number;
}

export class WorkOSService {
  /**
   * Get authorization URL for user login
   * For email/password auth: No connection/organization/provider needed (enabled by default)
   * For SSO/OAuth: Requires WORKOS_CONNECTION_ID or WORKOS_ORGANIZATION_ID
   * @param state - Optional state parameter for OAuth flow (echoed back on the redirect)
   * @param customRedirectUri - Optional custom redirect URI (for mobile deep linking)
   * @param codeChallenge - Optional PKCE S256 code challenge (RFC 7636). When set, WorkOS
   *   binds the issued code to it and the exchange must supply the matching verifier.
   */
  static async getAuthorizationUrl(
    state?: string,
    customRedirectUri?: string,
    codeChallenge?: string
  ): Promise<string> {
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

    if (codeChallenge) {
      return workos.userManagement.getAuthorizationUrl({
        ...params,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });
    }
    return workos.userManagement.getAuthorizationUrl(params);
  }

  /**
   * Exchange authorization code for user token.
   * @param codeVerifier - PKCE verifier matching the challenge sent on the
   *   authorization request. Required by WorkOS when the code was issued with one.
   */
  static async exchangeCodeForToken(code: string, codeVerifier?: string): Promise<WorkOSAuthentication> {
    return workos.userManagement.authenticateWithCode({
      clientId: WORKOS_CLIENT_ID,
      code,
      ...(codeVerifier ? { codeVerifier } : {}),
    });
  }

  /**
   * Exchange a refresh token for a fresh access/refresh token pair.
   * WorkOS access tokens are short-lived (minutes); clients must call this
   * before/after expiry instead of holding one access token forever. WorkOS
   * rotates the refresh token on every use, so callers must persist the new one.
   */
  static async refreshSession(refreshToken: string): Promise<WorkOSAuthentication> {
    return workos.userManagement.authenticateWithRefreshToken({
      clientId: WORKOS_CLIENT_ID,
      refreshToken,
    });
  }

  /**
   * Revoke a WorkOS session (server-side logout).
   *
   * Revoking the session invalidates the refresh token bound to it, so a
   * leaked refresh token can no longer mint new access tokens after the user
   * logs out. The `sessionId` is the `sid` claim of a verified access token.
   */
  static async revokeSession(sessionId: string): Promise<void> {
    await workos.userManagement.revokeSession({ sessionId });
  }

  /**
   * Get user information from WorkOS
   */
  static async getUser(userId: string): Promise<WorkOSUser> {
    return workos.userManagement.getUser(userId);
  }

  /**
   * List users from WorkOS
   */
  static async listUsers(options?: {
    email?: string;
    limit?: number;
    cursor?: string;
  }): Promise<WorkOSUserList> {
    return workos.userManagement.listUsers(options);
  }

  /**
   * Create or link the local user for a WorkOS identity (audit #2, #25).
   *
   * Resolution order:
   * 1. `workosUserId` match — the identity is already linked; refresh
   *    `emailVerified` (and `email` if it changed in WorkOS), fill in the
   *    avatar only if we have none. Never overwrite name/avatar edits made
   *    in-app.
   * 2. `email` match on a row with **no** `workosUserId` — a pre-provisioned
   *    row (invited player, managed roster player). Claim it: set
   *    `workosUserId`, drop `isManaged`/`managedById` so the creating coach
   *    loses control of what is now a real account, and re-evaluate the admin
   *    allowlist (a pre-seeded row must not suppress ADMIN bootstrap).
   * 3. `email` match on a row linked to a *different* WorkOS identity —
   *    refuse with 409 rather than silently merging accounts.
   * 4. Otherwise create.
   *
   * Unique-constraint races surface as `ConflictError` (409), not 500.
   */
  static async syncUser(workosUser: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    emailVerified: boolean;
    profilePictureUrl?: string;
  }): Promise<User> {
    const fullName = [workosUser.firstName, workosUser.lastName]
      .filter(Boolean)
      .join(' ') || workosUser.email.split('@')[0];
    const emailVerified = workosUser.emailVerified || false;
    const workosAvatar = workosUser.profilePictureUrl || null;

    // 1. Already linked by WorkOS id
    const linked = await prisma.user.findUnique({ where: { workosUserId: workosUser.id } });
    if (linked) {
      return WorkOSService.mapUniqueViolation(() =>
        prisma.user.update({
          where: { id: linked.id },
          data: {
            emailVerified,
            ...(linked.email !== workosUser.email && { email: workosUser.email }),
            ...(linked.profilePictureUrl === null && workosAvatar && { profilePictureUrl: workosAvatar }),
          },
        })
      );
    }

    // 2./3. Pre-provisioned row with the same email
    const byEmail = await prisma.user.findUnique({ where: { email: workosUser.email } });
    if (byEmail) {
      if (byEmail.workosUserId) {
        logger.warn('Refusing to link WorkOS identity to an email owned by another identity', {
          userId: byEmail.id,
        });
        throw new ConflictError('An account with this email is already linked to a different login');
      }

      const promoteToAdmin = byEmail.role !== 'ADMIN' && isAdminEmail(workosUser.email);
      logger.info('Linking WorkOS identity to pre-provisioned user', {
        userId: byEmail.id,
        wasManaged: byEmail.isManaged,
        promoteToAdmin,
      });

      return WorkOSService.mapUniqueViolation(() =>
        prisma.user.update({
          where: { id: byEmail.id },
          data: {
            workosUserId: workosUser.id,
            emailVerified,
            // The person behind this email now owns the account
            isManaged: false,
            managedById: null,
            ...(promoteToAdmin && { role: 'ADMIN' }),
            ...(byEmail.profilePictureUrl === null && workosAvatar && { profilePictureUrl: workosAvatar }),
          },
        })
      );
    }

    // 4. Brand-new user. Default role is PLAYER (self-selectable to COACH).
    return WorkOSService.mapUniqueViolation(() =>
      prisma.user.create({
        data: {
          workosUserId: workosUser.id,
          email: workosUser.email,
          name: fullName,
          role: isAdminEmail(workosUser.email) ? 'ADMIN' : 'PLAYER',
          emailVerified,
          profilePictureUrl: workosAvatar,
        },
      })
    );
  }

  /** Turn a Prisma unique-constraint violation (P2002) into a 409 instead of a 500. */
  private static async mapUniqueViolation<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('An account with this email already exists');
      }
      throw error;
    }
  }

  /**
   * Verify a WorkOS access token.
   *
   * The signature is checked against the WorkOS JWKS for this client, and the
   * `iss`, `exp` and `sub` claims are required. Nothing about the caller is
   * trusted until `jwtVerify` succeeds — in particular the payload is never
   * decoded by hand (a previous implementation did, which let an unsigned
   * `{"sub": "<victim>"}` token impersonate any user).
   *
   * Returns `null` for any token that fails verification (malformed, bad
   * signature, expired, wrong issuer). Key-fetch failures surface as a thrown
   * error so callers can return 503 rather than treating an outage as a
   * rejected token.
   */
  static async verifyToken(accessToken: string): Promise<VerifiedToken | null> {
    // Cheap structural gate before any key lookup: must be a compact JWS whose
    // header names an allowed asymmetric algorithm. Rejects `alg: none`, HMAC
    // downgrade attempts and plain garbage without a JWKS round-trip.
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(accessToken).alg;
    } catch {
      return null;
    }
    if (!alg || !ALLOWED_JWT_ALGS.includes(alg)) {
      logger.warn('Rejected WorkOS access token', { reason: 'disallowed alg', alg });
      return null;
    }

    try {
      const { payload } = await jwtVerify(accessToken, getWorkOSJwks(), {
        algorithms: ALLOWED_JWT_ALGS,
        issuer: WORKOS_JWT_ISSUER,
        requiredClaims: ['exp', 'sub'],
        // Small tolerance for clock skew between WorkOS and the API host.
        clockTolerance: 30,
      });

      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || typeof payload.exp !== 'number') {
        return null;
      }

      return {
        id: payload.sub,
        sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
        expiresAt: payload.exp,
      };
    } catch (error) {
      if (error instanceof joseErrors.JOSEError && !(error instanceof joseErrors.JWKSTimeout)) {
        // JWTExpired, JWSSignatureVerificationFailed, JWTClaimValidationFailed,
        // JWSInvalid, JWKSNoMatchingKey, ... — all mean "not a valid token".
        logger.warn('Rejected WorkOS access token', { code: error.code, message: error.message });
        return null;
      }
      // Network / JWKS fetch failure: not the caller's fault.
      logger.error('Unable to verify WorkOS access token', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError('Authentication service unavailable');
    }
  }
}

