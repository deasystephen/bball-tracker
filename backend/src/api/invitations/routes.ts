/**
 * Invitation API routes
 */

import { Router } from 'express';
import { InvitationService } from '../../services/invitation-service';
import { GuardianService } from '../../services/guardian-service';
import {
  invitationQuerySchema,
} from './schemas';
import { authenticate } from '../auth/middleware';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/errors';
import { validateUuidParams } from '../middleware/validate-params';
import { logger } from '../../utils/logger';
import { omitToken } from './serializers';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/v1/invitations
 * List invitations with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = invitationQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await InvitationService.listInvitations(
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      ...result,
      invitations: result.invitations.map(omitToken),
    });
  } catch (error) {
    logger.error('Error listing invitations', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list invitations' });
    }
  }
});

/**
 * GET /api/v1/invitations/:id
 * Get an invitation by ID
 */
router.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const invitation = await InvitationService.getInvitationById(
      req.params.id as string,
      req.user!.id
    );

    res.json({
      success: true,
      invitation: omitToken(invitation),
    });
  } catch (error) {
    logger.error('Error getting invitation', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get invitation' });
    }
  }
});

/**
 * POST /api/v1/invitations/:id/accept
 * Accept an invitation (player only)
 */
router.post('/:id/accept', validateUuidParams('id'), async (req, res) => {
  try {
    const id = req.params.id as string;

    // Guardian invitation (PARENT role) addressed to the signed-in adult?
    // Mirrors the by-token accept; the id is tried as a GuardianInvitation
    // first because its accept creates a Guardian link, not a TeamMember.
    const guardianInvitation = await GuardianService.findInvitationForUser(id, req.user!.id);
    if (guardianInvitation) {
      const accepted = await GuardianService.acceptInvitation(id, req.user!.id);
      res.json({
        success: true,
        kind: 'guardian',
        invitation: omitToken(accepted.invitation),
        guardian: accepted.guardian,
        message: 'Invitation accepted. You are now a guardian of this player.',
      });
      return;
    }

    const result = await InvitationService.acceptInvitation(id, req.user!.id);

    res.json({
      success: true,
      kind: 'team',
      invitation: omitToken(result.invitation),
      teamMember: result.teamMember,
      message: 'Invitation accepted. You have been added to the team.',
    });
  } catch (error) {
    logger.error('Error accepting invitation', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to accept invitation' });
    }
  }
});

/**
 * POST /api/v1/invitations/:id/reject
 * Reject an invitation (player only)
 */
router.post('/:id/reject', validateUuidParams('id'), async (req, res) => {
  try {
    const id = req.params.id as string;

    const guardianInvitation = await GuardianService.findInvitationForUser(id, req.user!.id);
    if (guardianInvitation) {
      const rejected = await GuardianService.rejectInvitation(id, req.user!.id);
      res.json({
        success: true,
        kind: 'guardian',
        invitation: omitToken(rejected),
        message: 'Invitation rejected.',
      });
      return;
    }

    const invitation = await InvitationService.rejectInvitation(id, req.user!.id);

    res.json({
      success: true,
      kind: 'team',
      invitation: omitToken(invitation),
      message: 'Invitation rejected.',
    });
  } catch (error) {
    logger.error('Error rejecting invitation', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to reject invitation' });
    }
  }
});

/**
 * DELETE /api/v1/invitations/:id
 * Cancel an invitation (coach only)
 */
router.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const invitation = await InvitationService.cancelInvitation(
      req.params.id as string,
      req.user!.id
    );

    res.json({
      success: true,
      invitation: omitToken(invitation),
      message: 'Invitation cancelled.',
    });
  } catch (error) {
    logger.error('Error cancelling invitation', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to cancel invitation' });
    }
  }
});

export default router;
