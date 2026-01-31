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
} from './schemas';
import { BadRequestError, NotFoundError } from '../../utils/errors';

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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const league = await LeagueService.createLeague(validationResult.data, req.user!.id);

    res.status(201).json({
      success: true,
      league,
    });
  } catch (error) {
    console.error('Error creating league:', error);
    if (error instanceof BadRequestError || error instanceof NotFoundError) {
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
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await LeagueService.listLeagues(validationResult.data);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error listing leagues:', error);
    if (error instanceof BadRequestError) {
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
    const league = await LeagueService.getLeagueById(req.params.id);

    res.json({
      success: true,
      league,
    });
  } catch (error) {
    console.error('Error getting league:', error);
    if (error instanceof NotFoundError || error instanceof BadRequestError) {
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
        validationResult.error.errors.map((e) => e.message).join(', ')
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
    console.error('Error updating league:', error);
    if (error instanceof NotFoundError || error instanceof BadRequestError) {
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
    console.error('Error deleting league:', error);
    if (error instanceof NotFoundError || error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete league' });
    }
  }
});

export default router;
