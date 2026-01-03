/**
 * Games API routes
 */

import { Router } from 'express';
import { GameService } from '../../services/game-service';
import { authenticate } from '../auth/middleware';
import {
  createGameSchema,
  updateGameSchema,
  gameQuerySchema,
} from './schemas';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/games
 * Create a new game
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validationResult = createGameSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const game = await GameService.createGame(validationResult.data, req.user!.id);

    res.status(201).json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('Error creating game:', error);
    if (error instanceof BadRequestError || error instanceof ForbiddenError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create game' });
    }
  }
});

/**
 * GET /api/v1/games
 * List games with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = gameQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await GameService.listGames(validationResult.data, req.user!.id);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error listing games:', error);
    if (error instanceof BadRequestError) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list games' });
    }
  }
});

/**
 * GET /api/v1/games/:id
 * Get a game by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const game = await GameService.getGameById(req.params.id, req.user!.id);

    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('Error getting game:', error);
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get game' });
    }
  }
});

/**
 * PATCH /api/v1/games/:id
 * Update a game
 */
router.patch('/:id', async (req, res) => {
  try {
    // Validate request body
    const validationResult = updateGameSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const game = await GameService.updateGame(
      req.params.id,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('Error updating game:', error);
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update game' });
    }
  }
});

/**
 * DELETE /api/v1/games/:id
 * Delete a game
 */
router.delete('/:id', async (req, res) => {
  try {
    await GameService.deleteGame(req.params.id, req.user!.id);

    res.json({
      success: true,
      message: 'Game deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting game:', error);
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete game' });
    }
  }
});

export default router;
