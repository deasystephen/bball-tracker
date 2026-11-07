/**
 * Authentication middleware for protecting routes
 */

import { Request, Response, NextFunction } from 'express';
import { SubscriptionTier } from '@prisma/client';
import { WorkOSService } from '../../services/workos-service';
import { AgeConfirmationRequiredError, UnauthorizedError } from '../../utils/errors';
import { setLogContextUser } from '../../utils/log-context';
import prisma from '../../models';

/**
 * The columns `authenticate` attaches as `req.user`. Single-sourced for the
 * dev-token and WorkOS branches (and mirrored by the socket handshake in
 * `websocket/game-events.ts`), so a column added for a gate reaches both.
 */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  subscriptionTier: true,
  subscriptionExpiresAt: true,
  ageConfirmedAt: true,
} as const;

/**
 * Routes an account that has not yet answered the age question may call
 * (#981): read who it is, answer the question, leave, and the two writes that
 * end a session on the device (push-token removal runs inside the logout
 * sequence, account deletion is the person's right whatever their age).
 * Everything else is 403 `age_confirmation_required` while
 * `AGE_GATE_ENFORCED` is on. Matched on the method and the path below
 * `/api/v1/auth` (`req.baseUrl` + `req.path`, so a trailing slash or a query
 * string does not matter).
 */
export const AGE_GATE_EXEMPT: ReadonlySet<string> = new Set([
  'GET /auth/me',
  'POST /auth/age-confirmation',
  'POST /auth/logout',
  'DELETE /auth/me',
  'DELETE /auth/push-token',
]);

/**
 * Whether unanswered accounts are refused (#981). `AGE_GATE_ENFORCED=false`
 * in the task definition keeps the API permissive while the mobile update
 * that carries the age screen reaches devices: an older client would
 * otherwise see 403 on every screen. Read on each call so a test can flip it.
 * Unset means enforced: the flag exists to relax, never to forget.
 */
export function ageGateEnforced(): boolean {
  return process.env.AGE_GATE_ENFORCED !== 'false';
}

/** The `METHOD /path` key of a request, with the `/api/v1` prefix and any trailing slash removed. */
function routeKey(req: Request): string {
  const full = `${req.baseUrl}${req.path}`.replace(/^\/api\/v1/, '').replace(/\/+$/, '');
  return `${req.method.toUpperCase()} ${full}`;
}

/**
 * The age gate (#981): an authenticated row whose `ageConfirmedAt` is null may
 * reach only the exempt routes. Throws `AgeConfirmationRequiredError` (403)
 * otherwise; `authenticate` calls it after attaching `req.user`.
 */
export function assertAgeConfirmed(req: Request, user: { ageConfirmedAt: Date | null }): void {
  if (user.ageConfirmedAt !== null || !ageGateEnforced()) return;
  if (AGE_GATE_EXEMPT.has(routeKey(req))) return;
  throw new AgeConfirmationRequiredError();
}

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
        /** Null until the age question is answered (#981); see `assertAgeConfirmed`. */
        ageConfirmedAt: Date | null;
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
      let gated: { ageConfirmedAt: Date | null };
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
          select: AUTH_USER_SELECT,
        });

        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        req.user = user;
        setLogContextUser(user.id);
        // Outside the try: the gate's 403 must not be rewritten as 401.
        gated = user;
      } catch (_e) {
        throw new UnauthorizedError('Invalid dev token');
      }
      assertAgeConfirmed(req, gated);
      return next();
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
      select: AUTH_USER_SELECT,
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    // Attach user to request (and to the log context, so every line written
    // while this request is handled carries the caller's id, #617).
    req.user = user;
    setLogContextUser(user.id);
    // The age gate (#981) runs last, so its 403 carries the caller's id in the log context.
    assertAgeConfirmed(req, user);
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

