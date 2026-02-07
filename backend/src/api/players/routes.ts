/**
 * Player API routes
 */

import { Router } from 'express';
import { PlayerService } from '../../services/player-service';
import {
  createPlayerSchema,
  updatePlayerSchema,
  playerQuerySchema,
} from './schemas';
import { authenticate } from '../auth/middleware';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/errors';
import { validateUuidParams } from '../middleware/validate-params';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/players
 * Create a new player
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validationResult = createPlayerSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const player = await PlayerService.createPlayer(
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      player,
    });
  } catch (error) {
    console.error('Error creating player:', error);
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create player' });
    }
  }
});

/**
 * GET /api/v1/players
 * List players with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = playerQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await PlayerService.listPlayers(validationResult.data);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error listing players:', error);
    if (error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list players' });
    }
  }
});

/**
 * GET /api/v1/players/:id
 * Get a player by ID
 */
router.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const player = await PlayerService.getPlayerById(req.params.id);

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    console.error('Error getting player:', error);
    if (error instanceof NotFoundError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get player' });
    }
  }
});

/**
 * PATCH /api/v1/players/:id
 * Update a player
 */
router.patch('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    // Validate request body
    const validationResult = updatePlayerSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const player = await PlayerService.updatePlayer(
      req.params.id,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    console.error('Error updating player:', error);
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update player' });
    }
  }
});

/**
 * DELETE /api/v1/players/:id
 * Delete a player
 */
router.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    await PlayerService.deletePlayer(req.params.id, req.user!.id);

    res.json({
      success: true,
      message: 'Player deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting player:', error);
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete player' });
    }
  }
});

export default router;
