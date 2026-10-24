/**
 * Public invitation routes — no authentication required.
 * The invitation token itself is the shared secret.
 *
 * A token resolves to EITHER a TeamInvitation (`kind: 'team'`) or a
 * GuardianInvitation (`kind: 'guardian'`, PARENT role —
 * docs/plans/parent-role-spec.md). Team invitations are looked up first; a
 * miss falls through to guardian invitations.
 *
 * Mount these BEFORE the auth-protected invitation router so Express
 * resolves /by-token/* without hitting the authenticate middleware.
 */

import { Router } from 'express';
import { InvitationService } from '../../services/invitation-service';
import { GuardianService } from '../../services/guardian-service';
import { NotFoundError } from '../../utils/errors';
import { respondWithError } from '../../utils/respond-with-error';
import { logger } from '../../utils/logger';
import { omitToken } from './serializers';
import {
  invitationLookupIpRateLimit,
  invitationTokenRateLimit,
  inviteAcceptRateLimit,
} from '../middleware/rate-limit';

const router = Router();

/** Every 404 on this public surface reads the same, whichever row was missing. */
const INVITATION_NOT_FOUND = 'Invitation not found';

const TOKEN_RE = /^[A-Za-z0-9\-_]+$/;

function validateToken(token: string): boolean {
  return TOKEN_RE.test(token) && token.length >= 8 && token.length <= 128;
}

/** What the recipient saw on a by-token lookup (#964): the stored status, or `expired` once past `expiresAt`. */
export type InvitationViewState = 'pending' | 'expired' | 'accepted' | 'rejected' | 'cancelled';

/**
 * A PENDING row past its `expiresAt` reads as expired: the web page and the
 * app both render it as "Invitation Expired" (the stored status flips lazily,
 * on an accept attempt or a list read).
 */
export function invitationViewState(
  invitation: { status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'; expiresAt: string },
  now: Date = new Date()
): InvitationViewState {
  if (invitation.status === 'PENDING') {
    return new Date(invitation.expiresAt) < now ? 'expired' : 'pending';
  }
  return invitation.status.toLowerCase() as InvitationViewState;
}

/**
 * Run the team-invitation lookup first; on NotFound, try the guardian one.
 */
async function resolveByKind<T, G>(
  team: () => Promise<T>,
  guardian: () => Promise<G>
): Promise<T | G> {
  try {
    return await team();
  } catch (error) {
    if (error instanceof NotFoundError) {
      return guardian();
    }
    throw error;
  }
}

/**
 * GET /api/v1/invitations/by-token/:token
 * Returns invitation details for display on the web landing page.
 * Intentionally returns a limited view (no player PII).
 *
 * Rate-limited per token (audit #36) plus a loose per-IP ceiling (#718): the
 * web invite page fetches this server-side from one egress IP, so it is
 * exempt from the global 100/min IP limit, but a loop of random tokens still
 * hits invitationLookupIpRateLimit. The accept route below stays on the
 * IP-keyed inviteAcceptRateLimit because the browser calls it directly.
 *
 * A successful lookup logs `Invitation viewed by token` (#964, the invite
 * funnel): the invitation id, its kind, the state the recipient saw and the
 * caller's `client` (`X-Hooplings-Client`: `web` for the hooplings.com page,
 * `ios/…` for the app). Never the token. 400/404/429/5xx are on the
 * `HTTP request` line already.
 */
router.get('/by-token/:token', invitationLookupIpRateLimit, invitationTokenRateLimit, async (req, res) => {
  const { token } = req.params;

  if (!validateToken(token as string)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  try {
    const invitation = await resolveByKind(
      async () => ({
        kind: 'team' as const,
        ...(await InvitationService.getInvitationByToken(token as string)),
      }),
      () => GuardianService.getInvitationByToken(token as string)
    );
    logger.info('Invitation viewed by token', {
      invitationId: invitation.id,
      kind: invitation.kind,
      state: invitationViewState(invitation),
      client: req.hooplingsClient ?? null,
    });
    res.json({ success: true, invitation: omitToken(invitation) });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error fetching invitation by token',
      fallback: 'Failed to fetch invitation',
      notFound: INVITATION_NOT_FOUND,
    });
  }
});

/**
 * POST /api/v1/invitations/by-token/:token/accept
 * Accepts the invitation on behalf of the invited player (team kind) or the
 * invited adult (guardian kind — creates the Guardian link).
 * Token acts as authentication (one-time secret, like a password-reset link).
 */
router.post('/by-token/:token/accept', inviteAcceptRateLimit, async (req, res) => {
  const { token } = req.params;

  if (!validateToken(token as string)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  try {
    const result = await resolveByKind(
      async () => {
        const accepted = await InvitationService.acceptInvitationByToken(token as string);
        return {
          kind: 'team' as const,
          invitation: omitToken(accepted.invitation),
          teamMember: accepted.teamMember,
          message: 'Invitation accepted. You have been added to the team.',
        };
      },
      async () => {
        const accepted = await GuardianService.acceptInvitationByToken(token as string);
        return {
          kind: 'guardian' as const,
          invitation: omitToken(accepted.invitation),
          guardian: accepted.guardian,
          message: 'Invitation accepted. You are now a guardian of this player.',
        };
      }
    );
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error accepting invitation by token',
      fallback: 'Failed to accept invitation',
      notFound: INVITATION_NOT_FOUND,
    });
  }
});

export default router;
