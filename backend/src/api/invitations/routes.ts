/**
 * Invitation API routes
 */

import { Router } from 'express';
import { InvitationService } from '../../services/invitation-service';
import {
  invitationQuerySchema,
} from './schemas';
import { authenticate } from '../auth/middleware';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/errors';

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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await InvitationService.listInvitations(
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error listing invitations:', error);
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
router.get('/:id', async (req, res) => {
  try {
    const invitation = await InvitationService.getInvitationById(
      req.params.id,
      req.user!.id
    );

    res.json({
      success: true,
      invitation,
    });
  } catch (error) {
    console.error('Error getting invitation:', error);
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
router.post('/:id/accept', async (req, res) => {
  try {
    const result = await InvitationService.acceptInvitation(
      req.params.id,
      req.user!.id
    );

    res.json({
      success: true,
      invitation: result.invitation,
      teamMember: result.teamMember,
      message: 'Invitation accepted. You have been added to the team.',
    });
  } catch (error) {
    console.error('Error accepting invitation:', error);
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
router.post('/:id/reject', async (req, res) => {
  try {
    const invitation = await InvitationService.rejectInvitation(
      req.params.id,
      req.user!.id
    );

    res.json({
      success: true,
      invitation,
      message: 'Invitation rejected.',
    });
  } catch (error) {
    console.error('Error rejecting invitation:', error);
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
router.delete('/:id', async (req, res) => {
  try {
    const invitation = await InvitationService.cancelInvitation(
      req.params.id,
      req.user!.id
    );

    res.json({
      success: true,
      invitation,
      message: 'Invitation cancelled.',
    });
  } catch (error) {
    console.error('Error cancelling invitation:', error);
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
