/**
 * Invitation API routes
 */

import { Router } from 'express';
import { InvitationService } from '../../services/invitation-service';
import { GuardianService } from '../../services/guardian-service';
import { StaffInvitationService } from '../../services/staff-invitation-service';
import {
  invitationQuerySchema,
} from './schemas';
import { authenticate } from '../auth/middleware';
import { BadRequestError } from '../../utils/errors';
import { validateUuidParams } from '../middleware/validate-params';
import { respondWithError } from '../../utils/respond-with-error';
import { omitToken } from './serializers';
import { invalidateUsage } from '../../services/usage-service';

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

    const query = validationResult.data;
    const result = await InvitationService.listInvitations(query, req.user!.id);

    // Pending GuardianInvitations addressed to the caller (PARENT role) ride
    // along on the unfiltered / PENDING list so the Invitations tab can offer
    // "Accept for <child>". Team/player-scoped listings are coach views.
    const includeGuardian =
      !query.teamId && !query.playerId && (!query.status || query.status === 'PENDING');
    // Staff invitations addressed to the caller (#460) ride along the same
    // way, under their own key: a build that predates them ignores it, so a
    // staff invitation is never mis-rendered as a player invitation there.
    const [guardianInvitations, staffInvitations] = includeGuardian
      ? await Promise.all([
          GuardianService.listPendingForUser(req.user!.id),
          StaffInvitationService.listPendingForEmail(req.user!.email),
        ])
      : [[], []];

    res.json({
      success: true,
      ...result,
      invitations: result.invitations.map(omitToken),
      guardianInvitations: guardianInvitations.map(omitToken),
      staffInvitations: staffInvitations.map(omitToken),
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error listing invitations', fallback: 'Failed to list invitations' });
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
    respondWithError(res, error, { log: 'Error getting invitation', fallback: 'Failed to get invitation' });
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

    // Staff invitation (#460) addressed to the signed-in account? Tried
    // before the team kind: its accept creates a TeamStaff row. An app build
    // that predates staff invitations reaches here from its deep-link screen.
    const staffInvitation = await StaffInvitationService.findInvitationForUser(id, req.user!.id);
    if (staffInvitation) {
      const accepted = await StaffInvitationService.acceptInvitation(id, req.user!.id, staffInvitation);
      // Joining a team's staff changes the caller's metered team count.
      await invalidateUsage(req.user!.id);
      res.json({
        success: true,
        kind: 'staff',
        invitation: omitToken(accepted.invitation),
        staff: accepted.staff,
        alreadyStaff: accepted.alreadyStaff,
        message: 'Invitation accepted. You have been added to the team staff.',
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
    respondWithError(res, error, { log: 'Error accepting invitation', fallback: 'Failed to accept invitation' });
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

    const staffInvitation = await StaffInvitationService.findInvitationForUser(id, req.user!.id);
    if (staffInvitation) {
      const rejected = await StaffInvitationService.rejectInvitation(id, req.user!.id, staffInvitation);
      res.json({
        success: true,
        kind: 'staff',
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
    respondWithError(res, error, { log: 'Error rejecting invitation', fallback: 'Failed to reject invitation' });
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
    respondWithError(res, error, { log: 'Error cancelling invitation', fallback: 'Failed to cancel invitation' });
  }
});

export default router;
