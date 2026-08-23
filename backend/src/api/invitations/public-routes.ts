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
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  invitationTokenRateLimit,
  writeRateLimit,
} from '../middleware/rate-limit';

const router = Router();

const TOKEN_RE = /^[A-Za-z0-9\-_]+$/;

function validateToken(token: string): boolean {
  return TOKEN_RE.test(token) && token.length >= 8 && token.length <= 128;
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
 * Rate-limited per token, not per IP: the web invite page fetches this
 * server-side from one egress IP (audit #36). The accept route below stays on
 * the IP-keyed writeRateLimit because the browser calls it directly.
 */
router.get('/by-token/:token', invitationTokenRateLimit, async (req, res) => {
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
    res.json({ success: true, invitation });
  } catch (error) {
    logger.error('Error fetching invitation by token', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof NotFoundError) {
      res.status(404).json({ error: 'Invitation not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch invitation' });
    }
  }
});

/**
 * POST /api/v1/invitations/by-token/:token/accept
 * Accepts the invitation on behalf of the invited player (team kind) or the
 * invited adult (guardian kind — creates the Guardian link).
 * Token acts as authentication (one-time secret, like a password-reset link).
 */
router.post('/by-token/:token/accept', writeRateLimit, async (req, res) => {
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
          invitation: accepted.invitation,
          teamMember: accepted.teamMember,
          message: 'Invitation accepted. You have been added to the team.',
        };
      },
      async () => {
        const accepted = await GuardianService.acceptInvitationByToken(token as string);
        return {
          kind: 'guardian' as const,
          invitation: accepted.invitation,
          guardian: accepted.guardian,
          message: 'Invitation accepted. You are now a guardian of this player.',
        };
      }
    );
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error accepting invitation by token', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof BadRequestError) {
      res.status(400).json({ error: (error as BadRequestError).message });
    } else if (error instanceof NotFoundError) {
      res.status(404).json({ error: 'Invitation not found' });
    } else {
      res.status(500).json({ error: 'Failed to accept invitation' });
    }
  }
});

export default router;
