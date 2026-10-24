/**
 * WorkOS service layer for authentication and user management
 */

import { jwtVerify, decodeProtectedHeader, errors as joseErrors } from 'jose';
import { assertWorkOSConfig, getWorkOS, getWorkOSClientId, WORKOS_REDIRECT_URI, WORKOS_JWT_ISSUER, getWorkOSJwks } from '../utils/workos-client';
import { Prisma, User } from '@prisma/client';
import prisma from '../models';
import { logger } from '../utils/logger';
import { isAdminEmail } from '../utils/admin-emails';
import { EMAIL_SUPPRESSION_CLEARED } from '../utils/email-suppression';
import { emailEquals, isSameEmail, normaliseEmail } from '../utils/email-match';
import { ConflictError, EmailNotVerifiedError, ServiceUnavailableError } from '../utils/errors';

type UserManagement = ReturnType<typeof getWorkOS>['userManagement'];
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
  /** `iat`, epoch seconds, when the token carries one. */
  issuedAt?: number;
}

/** The WorkOS identity fields `syncUser` reads. */
export interface SyncUserInput {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified: boolean;
  profilePictureUrl?: string;
}

/** `syncUser`'s result: the row plus which branch produced it (#790). */
export interface SyncUserResult {
  user: User;
  /**
   * This sign-in claimed ANY pre-provisioned row (one with this email and no
   * `workosUserId`): a player a coach added by email, a `POST /players`
   * account, or an admin pre-create, whether or not a `TeamInvitation`
   * exists for it. `false` for a returning linked user, a new account, and a
   * lost claim race that falls through to a create.
   */
  claimedInvite: boolean;
  /**
   * The claimed row's `isManaged` before the claim: any managed row, coach-
   * managed roster player or guardian-managed child. Always `false` when
   * nothing was claimed.
   */
  wasManaged: boolean;
}

/**
 * Clock-skew tolerance, in seconds, applied to `exp` when verifying an access
 * token. The socket re-auth timer (`websocket/game-events.ts`) waits past it so
 * a token re-verified after expiry is really rejected (#49).
 */
export const JWT_CLOCK_TOLERANCE_SECONDS = 30;

/** Why `relinkUnknownIdentity` left a row alone; logged with the 409. */
export type RelinkRefusal = 'disabled' | 'email_unverified' | 'identity_exists' | 'row_changed';

/**
 * The cutover relink (#24) runs only while the owner has set
 * `WORKOS_RELINK_UNKNOWN_IDENTITIES=true` in `infra/task-definition.json`.
 * Read on every call, so a test can flip it.
 */
export function relinkEnabled(): boolean {
  return process.env.WORKOS_RELINK_UNKNOWN_IDENTITIES === 'true';
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
      clientId: getWorkOSClientId(),
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
      return getWorkOS().userManagement.getAuthorizationUrl({
        ...params,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });
    }
    return getWorkOS().userManagement.getAuthorizationUrl(params);
  }

  /**
   * Exchange authorization code for user token.
   * @param codeVerifier - PKCE verifier matching the challenge sent on the
   *   authorization request. Required by WorkOS when the code was issued with one.
   */
  static async exchangeCodeForToken(code: string, codeVerifier?: string): Promise<WorkOSAuthentication> {
    return getWorkOS().userManagement.authenticateWithCode({
      clientId: getWorkOSClientId(),
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
    return getWorkOS().userManagement.authenticateWithRefreshToken({
      clientId: getWorkOSClientId(),
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
    await getWorkOS().userManagement.revokeSession({ sessionId });
  }

  /**
   * Delete the WorkOS user behind a deleted account (#444, D3). Removes the
   * email, name and credentials from the identity provider and invalidates
   * every session and refresh token for it. Called best-effort AFTER the local
   * transaction has committed; the caller handles failure.
   */
  static async deleteUser(workosUserId: string): Promise<void> {
    await getWorkOS().userManagement.deleteUser(workosUserId);
  }

  /**
   * Get user information from WorkOS
   */
  static async getUser(userId: string): Promise<WorkOSUser> {
    return getWorkOS().userManagement.getUser(userId);
  }

  /**
   * List users from WorkOS
   */
  static async listUsers(options?: {
    email?: string;
    limit?: number;
    cursor?: string;
  }): Promise<WorkOSUserList> {
    return getWorkOS().userManagement.listUsers(options);
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
   *    Only when WorkOS reports the email verified (#907); an unverified
   *    sign-in is refused with `EmailNotVerifiedError` (403) and the row is
   *    left untouched.
   * 3. `email` match on a row linked to a *different* WorkOS identity:
   *    a. that identity does not exist in the WorkOS environment the API now
   *       runs against (the Staging → Production key cutover, #24, or a user
   *       deleted in the WorkOS dashboard), WorkOS reports this email
   *       verified, and the owner has turned the cutover relink on
   *       (`WORKOS_RELINK_UNKNOWN_IDENTITIES=true`): relink the row to the
   *       signing-in identity (`relinkUnknownIdentity`);
   *    b. otherwise refuse with 409 rather than silently merging accounts.
   * 4. Otherwise create.
   *
   * Email matching is case-insensitive through `emailEquals`, and a new
   * account stores the trimmed, lower-cased address (#955): WorkOS may return
   * an address in a different case from the one a coach typed, and a
   * case-sensitive match would split one person into two accounts.
   *
   * Unique-constraint races surface as `ConflictError` (409), not 500.
   *
   * Returns the row plus which branch produced it (#790): see `SyncUserResult`.
   */
  static async syncUser(workosUser: SyncUserInput): Promise<SyncUserResult> {
    const email = normaliseEmail(workosUser.email);
    const fullName = [workosUser.firstName, workosUser.lastName]
      .filter(Boolean)
      .join(' ') || email.split('@')[0];
    const emailVerified = workosUser.emailVerified || false;
    const workosAvatar = workosUser.profilePictureUrl || null;

    // Every write below is conditioned on `deletedAt IS NULL` (#444, D9): the
    // reads above are unlocked, so a sign-in that read the row a moment before
    // AccountService.deleteAccount committed would otherwise write the email or
    // WorkOS id straight back onto the tombstone. Zero rows updated means the
    // row was deleted underneath us — fall through to a fresh create, which is
    // exactly what a post-deletion sign-in gets in the steady state.

    // 1. Already linked by WorkOS id
    const linked = await prisma.user.findUnique({ where: { workosUserId: workosUser.id } });
    if (linked) {
      // A change of case alone is not a change of address: leave a legacy
      // mixed-case row and its delivery state alone (#955).
      const emailChanged = !isSameEmail(linked.email, email);
      if (emailChanged) {
        // `User.email` is unique byte for byte only; refuse a new address that
        // another live row holds in another case, as P2002 refuses an exact one.
        const holder = await prisma.user.findFirst({
          where: { email: emailEquals(email), deletedAt: null, NOT: { id: linked.id } },
          select: { id: true },
        });
        if (holder) {
          throw new ConflictError('An account with this email already exists');
        }
      }
      const updated = await WorkOSService.mapUniqueViolation(() =>
        prisma.user.updateMany({
          where: { id: linked.id, deletedAt: null },
          data: {
            emailVerified,
            ...(emailChanged && {
              email,
              ...EMAIL_SUPPRESSION_CLEARED,
            }),
            ...(linked.profilePictureUrl === null && workosAvatar && { profilePictureUrl: workosAvatar }),
          },
        })
      );
      if (updated.count === 1) {
        const user = await prisma.user.findUniqueOrThrow({ where: { id: linked.id } });
        return { user, claimedInvite: false, wasManaged: false };
      }
      logger.info('Linked user was deleted during sign-in; creating a fresh account', { userId: linked.id });
    }

    // 2./3. A live row with the same email, in any case
    const byEmail = await WorkOSService.findLiveUserByEmail(email);
    if (byEmail) {
      if (byEmail.workosUserId) {
        const relink = await WorkOSService.relinkUnknownIdentity(byEmail, {
          workosUserId: workosUser.id,
          emailVerified,
          workosAvatar,
        });
        if ('user' in relink) {
          return { user: relink.user, claimedInvite: false, wasManaged: false };
        }
        logger.warn('Refusing to link WorkOS identity to an email owned by another identity', {
          userId: byEmail.id,
          reason: relink.refused,
        });
        throw new ConflictError('An account with this email is already linked to a different login');
      }

      // Only a verified address may claim a pre-provisioned row (#907):
      // claiming hands over its team memberships and ends the coach's control.
      // `email` is unique, so there is no separate row to create instead.
      if (!emailVerified) {
        // info, not warn: the route's respondWithError already logs the 403 at warn.
        logger.info('Refused to link an unverified WorkOS email to a pre-provisioned user', {
          userId: byEmail.id,
        });
        throw new EmailNotVerifiedError();
      }

      const promoteToAdmin = byEmail.role !== 'ADMIN' && isAdminEmail(email);
      logger.info('Linking WorkOS identity to pre-provisioned user', {
        userId: byEmail.id,
        wasManaged: byEmail.isManaged,
        promoteToAdmin,
      });

      const claimed = await WorkOSService.mapUniqueViolation(() =>
        prisma.user.updateMany({
          // Claim-guarded like the RT4 write in team-service: still unclaimed
          // and not deleted. A concurrent claim or deletion leaves zero rows.
          where: { id: byEmail.id, workosUserId: null, deletedAt: null },
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
      if (claimed.count === 1) {
        const user = await prisma.user.findUniqueOrThrow({ where: { id: byEmail.id } });
        return { user, claimedInvite: true, wasManaged: byEmail.isManaged };
      }
      logger.info('Pre-provisioned user changed during sign-in; creating a fresh account', {
        userId: byEmail.id,
      });
    }

    // 4. Brand-new user. Default role is PLAYER (self-selectable to COACH).
    const created = await WorkOSService.mapUniqueViolation(() =>
      prisma.user.create({
        data: {
          workosUserId: workosUser.id,
          email,
          name: fullName,
          role: isAdminEmail(email) ? 'ADMIN' : 'PLAYER',
          emailVerified,
          profilePictureUrl: workosAvatar,
        },
      })
    );
    return { user: created, claimedInvite: false, wasManaged: false };
  }

  /**
   * The one live row holding `email`, compared case-insensitively with `_`
   * and `%` literal (`emailEquals`, #955). `User.email` is unique byte for
   * byte only, so two legacy rows can differ by case alone: that is refused
   * with 409 rather than guessed at. The cutover check
   * (`scripts/workos-cutover-check.mjs`) lists such rows so they are resolved
   * before the key switch (#24).
   */
  private static async findLiveUserByEmail(email: string): Promise<User | null> {
    const rows = await prisma.user.findMany({
      where: { email: emailEquals(email), deletedAt: null },
      take: 2,
    });
    if (rows.length > 1) {
      logger.warn('More than one live account matches a sign-in email case-insensitively', {
        userIds: rows.map((row) => row.id),
      });
      throw new ConflictError('More than one account matches this email; contact support');
    }
    return rows[0] ?? null;
  }

  /**
   * True when `workosUserId` names a user in the WorkOS environment the API
   * is configured for; false only on a definite 404 from WorkOS. Any other
   * failure is a 503: an account is never relinked on a guess.
   */
  static async identityExists(workosUserId: string): Promise<boolean> {
    try {
      await getWorkOS().userManagement.getUser(workosUserId);
      return true;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 404) {
        return false;
      }
      logger.error('WorkOS getUser failed while checking a linked identity', {
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError('Authentication service unavailable');
    }
  }

  /**
   * Branch 3a of `syncUser`: the WorkOS key cutover (#24). The row's
   * `workosUserId` names an identity the current WorkOS environment does not
   * know. After the switch from Staging to Production keys, that is every
   * account linked before the switch. The person signing in has proved the
   * same address to the new environment (WorkOS reports it verified), the
   * same evidence that lets a sign-in claim a pre-provisioned row, so the row
   * moves to the new identity and nothing else changes (role, memberships,
   * name, `isManaged`).
   *
   * **Off unless `WORKOS_RELINK_UNKNOWN_IDENTITIES=true`** (`relinkEnabled`).
   * The owner turns it on for the cutover and its rollback window and off
   * again afterwards (`docs/runbooks/workos-production-cutover.md`), so a
   * WorkOS user deleted in the dashboard later cannot hand its row to a new
   * sign-up for the same address.
   *
   * Refuses, having written nothing, when the flag is off, when WorkOS does
   * not report the email verified, when the old identity still exists (two
   * live identities for one address: a real conflict), or when the row moved
   * to some other identity underneath us; the caller logs the reason and
   * answers 409. A concurrent sign-in that already moved the row to *this*
   * identity is a success, not a conflict. Reversible by construction:
   * switching back to the old keys relinks each account the same way.
   */
  private static async relinkUnknownIdentity(
    row: User,
    incoming: { workosUserId: string; emailVerified: boolean; workosAvatar: string | null }
  ): Promise<{ user: User } | { refused: RelinkRefusal }> {
    const previousWorkosUserId = row.workosUserId;
    if (!relinkEnabled() || !previousWorkosUserId) {
      return { refused: 'disabled' };
    }
    if (!incoming.emailVerified) {
      return { refused: 'email_unverified' };
    }
    if (await WorkOSService.identityExists(previousWorkosUserId)) {
      return { refused: 'identity_exists' };
    }

    const relinked = await WorkOSService.mapUniqueViolation(() =>
      prisma.user.updateMany({
        // Compare-and-set on the stale id: a concurrent relink or deletion
        // leaves zero rows.
        where: { id: row.id, workosUserId: previousWorkosUserId, deletedAt: null },
        data: {
          workosUserId: incoming.workosUserId,
          emailVerified: true,
          ...(row.profilePictureUrl === null && incoming.workosAvatar && { profilePictureUrl: incoming.workosAvatar }),
        },
      })
    );
    if (relinked.count !== 1) {
      // A double-tapped or retried first sign-in: the other request already
      // moved the row to this same identity.
      const current = await prisma.user.findUnique({ where: { id: row.id } });
      if (current && !current.deletedAt && current.workosUserId === incoming.workosUserId) {
        return { user: current };
      }
      return { refused: 'row_changed' };
    }
    logger.info('Relinked user to a new WorkOS identity', { userId: row.id, previousWorkosUserId });
    return { user: await prisma.user.findUniqueOrThrow({ where: { id: row.id } }) };
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

    // Outside the try: a missing WorkOS config is a 500, not a JWKS outage.
    assertWorkOSConfig();
    try {
      const { payload } = await jwtVerify(accessToken, getWorkOSJwks(), {
        algorithms: ALLOWED_JWT_ALGS,
        issuer: WORKOS_JWT_ISSUER,
        requiredClaims: ['exp', 'sub'],
        // Small tolerance for clock skew between WorkOS and the API host.
        clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
      });

      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || typeof payload.exp !== 'number') {
        return null;
      }

      return {
        id: payload.sub,
        sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
        expiresAt: payload.exp,
        issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
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

