/**
 * Public invitation routes — no authentication required.
 * The invitation token itself is the shared secret.
 *
 * Mount these BEFORE the auth-protected invitation router so Express
 * resolves /by-token/* without hitting the authenticate middleware.
 */

import { Router } from 'express';
import { InvitationService } from '../../services/invitation-service';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  calendarFeedRateLimit,
  writeRateLimit,
} from '../middleware/rate-limit';

const router = Router();

const TOKEN_RE = /^[A-Za-z0-9\-_]+$/;

function validateToken(token: string): boolean {
  return TOKEN_RE.test(token) && token.length >= 8 && token.length <= 128;
}

/**
 * GET /api/v1/invitations/by-token/:token
 * Returns invitation details for display on the web landing page.
 * Intentionally returns a limited view (no player PII).
 */
router.get('/by-token/:token', calendarFeedRateLimit, async (req, res) => {
  const { token } = req.params;

  if (!validateToken(token as string)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  try {
    const invitation = await InvitationService.getInvitationByToken(token as string);
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
 * Accepts the invitation on behalf of the invited player.
 * Token acts as authentication (one-time secret, like a password-reset link).
 */
router.post('/by-token/:token/accept', writeRateLimit, async (req, res) => {
  const { token } = req.params;

  if (!validateToken(token as string)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  try {
    const result = await InvitationService.acceptInvitationByToken(token as string);
    res.json({
      success: true,
      invitation: result.invitation,
      teamMember: result.teamMember,
      message: 'Invitation accepted. You have been added to the team.',
    });
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
