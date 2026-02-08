/**
 * Teams API routes
 */

import { Router } from 'express';
import { TeamService } from '../../services/team-service';
import { authenticate } from '../auth/middleware';
import {
  createTeamSchema,
  updateTeamSchema,
  updateTeamMemberSchema,
  teamQuerySchema,
  createManagedPlayerSchema,
} from './schemas';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { createInvitationSchema } from '../invitations/schemas';
import { InvitationService } from '../../services/invitation-service';
import { validateUuidParams } from '../middleware/validate-params';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/teams
 * Create a new team
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validationResult = createTeamSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const team = await TeamService.createTeam(validationResult.data, req.user!.id);

    res.status(201).json({
      success: true,
      team,
    });
  } catch (error) {
    console.error('Error creating team:', error);
    if (
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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await TeamService.listTeams(validationResult.data, req.user!.id);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error listing teams:', error);
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
    const team = await TeamService.getTeamById(req.params.id, req.user!.id);

    res.json({
      success: true,
      team,
    });
  } catch (error) {
    console.error('Error getting team:', error);
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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const team = await TeamService.updateTeam(
      req.params.id,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      team,
    });
  } catch (error) {
    console.error('Error updating team:', error);
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
    await TeamService.deleteTeam(req.params.id, req.user!.id);

    res.json({
      success: true,
      message: 'Team deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting team:', error);
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
 * POST /api/v1/teams/:id/players
 * DEPRECATED: Use POST /api/v1/teams/:id/invitations instead
 * Players must be invited and accept invitations to join teams
 */
router.post('/:id/players', async (_req, res) => {
  res.status(410).json({
    error: 'This endpoint has been removed. Please use the invitation system: POST /api/v1/teams/:id/invitations',
    deprecated: true,
  });
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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const teamMember = await TeamService.addManagedPlayer(
      req.params.teamId,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      teamMember,
    });
  } catch (error) {
    console.error('Error creating managed player:', error);
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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const invitation = await InvitationService.createInvitation(
      req.params.teamId,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      invitation,
    });
  } catch (error) {
    console.error('Error creating invitation:', error);
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
 * DELETE /api/v1/teams/:id/players/:playerId
 * Remove a player from a team
 */
router.delete('/:id/players/:playerId', validateUuidParams('id', 'playerId'), async (req, res) => {
  try {
    await TeamService.removePlayer(
      req.params.id,
      req.params.playerId,
      req.user!.id
    );

    res.json({
      success: true,
      message: 'Player removed from team successfully',
    });
  } catch (error) {
    console.error('Error removing player from team:', error);
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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const teamMember = await TeamService.updateTeamMember(
      req.params.id,
      req.params.playerId,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      teamMember,
    });
  } catch (error) {
    console.error('Error updating team member:', error);
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

export default router;
