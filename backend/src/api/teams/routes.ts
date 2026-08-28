/**
 * Teams API routes
 */

import { Router } from 'express';
import { TeamService } from '../../services/team-service';
import { StatsExportService } from '../../services/stats-export-service';
import { authenticate } from '../auth/middleware';
import {
  createTeamSchema,
  updateTeamSchema,
  updateTeamMemberSchema,
  teamQuerySchema,
  createManagedPlayerSchema,
  addRosterPlayerSchema,
  createAnnouncementSchema,
  announcementQuerySchema,
  addStaffSchema,
  updateStaffRoleSchema,
} from './schemas';
import { BadRequestError, NotFoundError, ForbiddenError, PaymentRequiredError } from '../../utils/errors';
import { invalidateUsage } from '../../services/usage-service';
import { createInvitationSchema, inviteGuardianSchema } from '../invitations/schemas';
import { InvitationService } from '../../services/invitation-service';
import { GuardianService } from '../../services/guardian-service';
import { omitToken } from '../invitations/serializers';
import { AnnouncementService } from '../../services/announcement-service';
import { validateUuidParams } from '../middleware/validate-params';
import { requireEntitlement, requireTeamCreateLimit } from '../middleware/entitlements';
import { Feature } from '../../services/entitlements';
import { logger } from '../../utils/logger';
import { buildContentDisposition } from '../../utils/content-disposition';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/teams
 * Create a new team.
 *
 * FREE-tier users are capped at FREE_TEAM_LIMIT teams (see
 * src/services/entitlements). `requireTeamCreateLimit` returns a 402 Payment
 * Required when the cap is reached so the client can surface an upgrade CTA.
 * Users already over the cap when enforcement shipped keep their existing teams
 * but cannot create new ones (grandfather rule — see usage-service). System
 * admins bypass the cap.
 */
router.post('/', requireTeamCreateLimit(), async (req, res) => {
  try {
    // Validate request body
    const validationResult = createTeamSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    // The tier team cap gets a cheap pre-check in `requireTeamCreateLimit()`
    // (402 on denial; admins bypass) and is enforced authoritatively inside
    // `TeamService.createTeam`'s transaction, which throws PaymentRequiredError.
    const team = await TeamService.createTeam(validationResult.data, req.user!.id);

    // A new team changes the user's metered counts — invalidate cached usage.
    await invalidateUsage(req.user!.id);

    res.status(201).json({
      success: true,
      team,
    });
  } catch (error) {
    logger.error('Error creating team', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof PaymentRequiredError) {
      res.status(error.statusCode).json({ code: 'upgrade_required', ...error.details });
    } else if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create team' });
    }
  }
});

/**
 * GET /api/v1/teams
 * List teams with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = teamQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await TeamService.listTeams(validationResult.data, req.user!.id);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Error listing teams', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list teams' });
    }
  }
});

/**
 * GET /api/v1/teams/:id
 * Get a team by ID
 */
router.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const team = await TeamService.getTeamById(req.params.id as string, req.user!.id);

    res.json({
      success: true,
      team,
    });
  } catch (error) {
    logger.error('Error getting team', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get team' });
    }
  }
});

/**
 * PATCH /api/v1/teams/:id
 * Update a team
 */
router.patch('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    // Validate request body
    const validationResult = updateTeamSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const team = await TeamService.updateTeam(
      req.params.id as string,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      team,
    });
  } catch (error) {
    logger.error('Error updating team', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update team' });
    }
  }
});

/**
 * DELETE /api/v1/teams/:id
 * Delete a team
 */
router.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    await TeamService.deleteTeam(req.params.id as string, req.user!.id);

    // Deleting a team changes the user's metered counts — invalidate cache.
    await invalidateUsage(req.user!.id);

    res.json({
      success: true,
      message: 'Team deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting team', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete team' });
    }
  }
});

/**
 * POST /api/v1/teams/:teamId/players
 * Unified Add Player (roster/invite unification spec). Name required; player
 * email optional (invitation goes out when present); guardian email optional.
 * Supersedes POST /teams/:id/managed-players and the {name,email} arm of
 * POST /teams/:id/invitations (both stay mounted for old clients).
 *
 * (This path previously answered 410 — the pre-2026 direct roster-add was
 * removed in favor of invitations. The unified flow deliberately reclaims it.)
 */
router.post('/:teamId/players', validateUuidParams('teamId'), async (req, res) => {
  try {
    const validationResult = addRosterPlayerSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await InvitationService.addRosterPlayer(
      req.params.teamId as string,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      ...result,
      // Defense in depth (audit #14): the service already returns token-free
      // summaries; strip again at the route like every invitation route.
      invitation: result.invitation && omitToken(result.invitation),
    });
  } catch (error) {
    logger.error('Error adding roster player', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to add player' });
    }
  }
});

/**
 * POST /api/v1/teams/:teamId/managed-players
 * Create a managed player on a team (COPPA compliant - no email required)
 */
router.post('/:teamId/managed-players', validateUuidParams('teamId'), async (req, res) => {
  try {
    // Validate request body
    const validationResult = createManagedPlayerSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const teamMember = await TeamService.addManagedPlayer(
      req.params.teamId as string,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      teamMember,
    });
  } catch (error) {
    logger.error('Error creating managed player', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create managed player' });
    }
  }
});

/**
 * POST /api/v1/teams/:teamId/invitations
 * Create a new team invitation (coach only)
 */
router.post('/:teamId/invitations', validateUuidParams('teamId'), async (req, res) => {
  try {
    // Validate request body
    const validationResult = createInvitationSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const { invitation, emailSent } = await InvitationService.createInvitation(
      req.params.teamId as string,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      invitation: omitToken(invitation),
      // null when the invited player has no email; false = send failed (the
      // client should warn the coach — unification spec, SES incident 2026-08-28)
      emailSent,
    });
  } catch (error) {
    logger.error('Error creating invitation', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create invitation' });
    }
  }
});

/**
 * POST /api/v1/teams/:teamId/members/:playerId/guardians
 * Invite an adult (by email) to be a guardian of a rostered player (PARENT
 * role). Requires canManageRoster. Body: { email, relationship }.
 */
router.post(
  '/:teamId/members/:playerId/guardians',
  validateUuidParams('teamId', 'playerId'),
  async (req, res) => {
    try {
      const validationResult = inviteGuardianSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw new BadRequestError(
          validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
        );
      }

      const { emailSent, ...invitation } = await GuardianService.inviteGuardian(
        req.params.teamId as string,
        req.params.playerId as string,
        validationResult.data,
        req.user!.id
      );

      // emailSent: false = the invite exists but the email failed (client
      // should warn the coach — unification spec, SES incident 2026-08-28)
      res.status(201).json({ success: true, invitation: omitToken(invitation), emailSent });
    } catch (error) {
      logger.error('Error inviting guardian', { error: error instanceof Error ? error.message : String(error) });
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to invite guardian' });
      }
    }
  }
);

/**
 * GET /api/v1/teams/:teamId/members/:playerId/guardians
 * Guardians + pending guardian invitations of a rostered player. Roster
 * managers and the player's own guardians may read this.
 */
router.get(
  '/:teamId/members/:playerId/guardians',
  validateUuidParams('teamId', 'playerId'),
  async (req, res) => {
    try {
      const result = await GuardianService.listGuardians(
        req.params.teamId as string,
        req.params.playerId as string,
        req.user!.id
      );

      res.json({
        success: true,
        guardians: result.guardians,
        pendingInvitations: result.pendingInvitations.map(omitToken),
      });
    } catch (error) {
      logger.error('Error listing guardians', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to list guardians' });
      }
    }
  }
);

/**
 * DELETE /api/v1/teams/:teamId/members/:playerId/guardians/:guardianUserId
 * Unlink a guardian (roster manager, or the guardian removing themself).
 */
router.delete(
  '/:teamId/members/:playerId/guardians/:guardianUserId',
  validateUuidParams('teamId', 'playerId', 'guardianUserId'),
  async (req, res) => {
    try {
      await GuardianService.removeGuardian(
        req.params.teamId as string,
        req.params.playerId as string,
        req.params.guardianUserId as string,
        req.user!.id
      );

      res.json({ success: true, message: 'Guardian removed successfully' });
    } catch (error) {
      logger.error('Error removing guardian', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to remove guardian' });
      }
    }
  }
);

/**
 * DELETE /api/v1/teams/:id/players/:playerId
 * Remove a player from a team
 */
router.delete('/:id/players/:playerId', validateUuidParams('id', 'playerId'), async (req, res) => {
  try {
    await TeamService.removePlayer(
      req.params.id as string,
      req.params.playerId as string,
      req.user!.id
    );

    res.json({
      success: true,
      message: 'Player removed from team successfully',
    });
  } catch (error) {
    logger.error('Error removing player from team', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to remove player from team' });
    }
  }
});

/**
 * PATCH /api/v1/teams/:id/players/:playerId
 * Update a team member (jersey number, position)
 */
router.patch('/:id/players/:playerId', validateUuidParams('id', 'playerId'), async (req, res) => {
  try {
    // Validate request body
    const validationResult = updateTeamMemberSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const teamMember = await TeamService.updateTeamMember(
      req.params.id as string,
      req.params.playerId as string,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      teamMember,
    });
  } catch (error) {
    logger.error('Error updating team member', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update team member' });
    }
  }
});

// ============================================
// Staff Routes (role matrix B2.3 / B2.7)
// ============================================

/**
 * GET /api/v1/teams/:teamId/staff
 * List the team's staff with user + role. Any team member/staff/admin may
 * read; `user.email` is only present for callers with canManageRoster.
 */
router.get('/:teamId/staff', validateUuidParams('teamId'), async (req, res) => {
  try {
    const staff = await TeamService.listStaff(req.params.teamId as string, req.user!.id);

    res.json({
      success: true,
      staff,
    });
  } catch (error) {
    logger.error('Error listing team staff', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list team staff' });
    }
  }
});

/**
 * GET /api/v1/teams/:teamId/roles
 * List the team's role definitions (default + custom) with their permission flags.
 */
router.get('/:teamId/roles', validateUuidParams('teamId'), async (req, res) => {
  try {
    const roles = await TeamService.getTeamRoles(req.params.teamId as string, req.user!.id);

    res.json({
      success: true,
      roles,
    });
  } catch (error) {
    logger.error('Error listing team roles', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list team roles' });
    }
  }
});

/**
 * POST /api/v1/teams/:teamId/staff
 * Add an EXISTING user (by userId or email) as staff with a default role type.
 * Head coach / league admin / system admin only (assistant coaches → 403).
 */
router.post('/:teamId/staff', validateUuidParams('teamId'), async (req, res) => {
  try {
    const validationResult = addStaffSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const staff = await TeamService.addStaffMember(
      req.params.teamId as string,
      validationResult.data,
      req.user!.id
    );

    // Being added as staff changes the added user's metered team count.
    await invalidateUsage(staff.userId);

    res.status(201).json({
      success: true,
      staff,
    });
  } catch (error) {
    logger.error('Error adding team staff', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to add team staff' });
    }
  }
});

/**
 * PATCH /api/v1/teams/:teamId/staff/:userId
 * Change a staff member's role type. Same gate as POST; the last head coach
 * cannot be demoted.
 */
router.patch('/:teamId/staff/:userId', validateUuidParams('teamId', 'userId'), async (req, res) => {
  try {
    const validationResult = updateStaffRoleSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const staff = await TeamService.changeStaffRole(
      req.params.teamId as string,
      req.params.userId as string,
      validationResult.data.roleType,
      req.user!.id
    );

    res.json({
      success: true,
      staff,
    });
  } catch (error) {
    logger.error('Error updating team staff role', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update team staff role' });
    }
  }
});

/**
 * DELETE /api/v1/teams/:teamId/staff/:userId
 * Remove a staff member. Head coach / league admin / system admin may remove
 * anyone; any staff member may remove themselves. The last head coach can
 * never be removed (400).
 */
router.delete('/:teamId/staff/:userId', validateUuidParams('teamId', 'userId'), async (req, res) => {
  try {
    const staffUserId = req.params.userId as string;
    await TeamService.removeStaffMember(req.params.teamId as string, staffUserId, req.user!.id);

    // Leaving a team changes the removed user's metered team count.
    await invalidateUsage(staffUserId);

    res.json({
      success: true,
      message: 'Staff member removed successfully',
    });
  } catch (error) {
    logger.error('Error removing team staff', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to remove team staff' });
    }
  }
});

// ============================================
// Announcement Routes
// ============================================

/**
 * POST /api/v1/teams/:teamId/announcements
 * Create a new team announcement (coach only)
 */
router.post('/:teamId/announcements', validateUuidParams('teamId'), async (req, res) => {
  try {
    const validationResult = createAnnouncementSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const announcement = await AnnouncementService.createAnnouncement(
      req.params.teamId as string,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      announcement,
    });
  } catch (error) {
    logger.error('Error creating announcement', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create announcement' });
    }
  }
});

/**
 * GET /api/v1/teams/:teamId/announcements
 * List announcements for a team
 */
router.get('/:teamId/announcements', validateUuidParams('teamId'), async (req, res) => {
  try {
    const validationResult = announcementQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await AnnouncementService.listAnnouncements(
      req.params.teamId as string,
      req.user!.id,
      validationResult.data
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Error listing announcements', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list announcements' });
    }
  }
});

// ============================================
// Stats Export Routes
// ============================================

/**
 * GET /api/v1/teams/:id/season-stats.csv
 * Export per-player season aggregates as CSV
 * Gated behind the STATS_EXPORT feature (PREMIUM+).
 */
router.get(
  '/:id/season-stats.csv',
  validateUuidParams('id'),
  requireEntitlement(Feature.STATS_EXPORT),
  async (req, res) => {
  try {
    const exportFile = await StatsExportService.exportTeamSeasonStatsCsv(
      req.params.id as string,
      req.user!.id
    );

    res.setHeader('Content-Type', exportFile.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(exportFile.filename));

    exportFile.stream.on('error', (err) => {
      logger.error('Stream error in team season CSV export', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to export team season CSV' });
      } else {
        res.end();
      }
    });
    exportFile.stream.pipe(res);
  } catch (error) {
    logger.error('Error exporting team season CSV', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to export team season CSV' });
    }
  }
  }
);

export default router;
