/**
 * Leagues API routes
 */

import { Router } from 'express';
import { LeagueService } from '../../services/league-service';
import { authenticate } from '../auth/middleware';
import {
  createLeagueSchema,
  updateLeagueSchema,
  leagueQuerySchema,
  addLeagueAdminSchema,
} from './schemas';
import { AppError, BadRequestError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { validateUuidParams } from '../middleware/validate-params';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/leagues
 * Create a new league
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validationResult = createLeagueSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const league = await LeagueService.createLeague(validationResult.data, req.user!.id);

    res.status(201).json({
      success: true,
      league,
    });
  } catch (error) {
    logger.error('Error creating league', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create league' });
    }
  }
});

/**
 * GET /api/v1/leagues
 * List leagues with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = leagueQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await LeagueService.listLeagues(validationResult.data, {
      id: req.user!.id,
      role: req.user!.role,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Error listing leagues', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list leagues' });
    }
  }
});

/**
 * GET /api/v1/leagues/:id
 * Get a league by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const league = await LeagueService.getLeagueById(req.params.id, req.user!.id);

    res.json({
      success: true,
      league,
    });
  } catch (error) {
    logger.error('Error getting league', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get league' });
    }
  }
});

/**
 * PATCH /api/v1/leagues/:id
 * Update a league
 */
router.patch('/:id', async (req, res) => {
  try {
    // Validate request body
    const validationResult = updateLeagueSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const league = await LeagueService.updateLeague(
      req.params.id,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      league,
    });
  } catch (error) {
    logger.error('Error updating league', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update league' });
    }
  }
});

/**
 * DELETE /api/v1/leagues/:id
 * Delete a league
 */
router.delete('/:id', async (req, res) => {
  try {
    await LeagueService.deleteLeague(req.params.id, req.user!.id);

    res.json({
      success: true,
      message: 'League deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting league', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete league' });
    }
  }
});

/**
 * POST /api/v1/leagues/:id/admins
 * Grant league-admin rights to a user. System ADMIN only (decision 3): the
 * service used to let any existing league admin add another; tightened until
 * there is a product decision on delegated league administration.
 */
router.post('/:id/admins', async (req, res) => {
  try {
    const validationResult = addLeagueAdminSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const admin = await LeagueService.addLeagueAdmin(
      req.params.id as string,
      validationResult.data.userId,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      admin,
    });
  } catch (error) {
    logger.error('Error adding league admin', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to add league admin' });
    }
  }
});

/**
 * DELETE /api/v1/leagues/:id/admins/:userId
 * Revoke league-admin rights. System ADMIN only.
 */
router.delete('/:id/admins/:userId', validateUuidParams('userId'), async (req, res) => {
  try {
    await LeagueService.removeLeagueAdmin(
      req.params.id as string,
      req.params.userId as string,
      req.user!.id
    );

    res.json({
      success: true,
      message: 'League admin removed successfully',
    });
  } catch (error) {
    logger.error('Error removing league admin', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to remove league admin' });
    }
  }
});

export default router;
