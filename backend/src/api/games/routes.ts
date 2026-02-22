/**
 * Games API routes
 */

import { Router } from 'express';
import { GameService } from '../../services/game-service';
import { GameEventService } from '../../services/game-event-service';
import { RsvpService } from '../../services/rsvp-service';
import { authenticate } from '../auth/middleware';
import {
  createGameSchema,
  updateGameSchema,
  gameQuerySchema,
  createGameEventSchema,
  gameEventQuerySchema,
  upsertRsvpSchema,
} from './schemas';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { validateUuidParams } from '../middleware/validate-params';
import { logger } from '../../utils/logger';

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
    logger.error('Error creating game', { error: error instanceof Error ? error.message : String(error) });
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
    logger.error('Error listing games', { error: error instanceof Error ? error.message : String(error) });
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
router.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const game = await GameService.getGameById(req.params.id, req.user!.id);

    res.json({
      success: true,
      game,
    });
  } catch (error) {
    logger.error('Error getting game', { error: error instanceof Error ? error.message : String(error) });
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
router.patch('/:id', validateUuidParams('id'), async (req, res) => {
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
    logger.error('Error updating game', { error: error instanceof Error ? error.message : String(error) });
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
router.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    await GameService.deleteGame(req.params.id, req.user!.id);

    res.json({
      success: true,
      message: 'Game deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting game', { error: error instanceof Error ? error.message : String(error) });
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

// ============================================
// Game Event Routes
// ============================================

/**
 * POST /api/v1/games/:gameId/events
 * Create a game event
 */
router.post('/:gameId/events', validateUuidParams('gameId'), async (req, res) => {
  try {
    // Validate request body
    const validationResult = createGameEventSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const event = await GameEventService.createEvent(
      req.params.gameId,
      validationResult.data,
      req.user!.id
    );

    res.status(201).json({
      success: true,
      event,
    });
  } catch (error) {
    logger.error('Error creating game event', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create game event' });
    }
  }
});

/**
 * GET /api/v1/games/:gameId/events
 * List events for a game
 */
router.get('/:gameId/events', validateUuidParams('gameId'), async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = gameEventQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await GameEventService.listEvents(
      req.params.gameId,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Error listing game events', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list game events' });
    }
  }
});

/**
 * GET /api/v1/games/:gameId/events/:eventId
 * Get a single game event
 */
router.get('/:gameId/events/:eventId', validateUuidParams('gameId', 'eventId'), async (req, res) => {
  try {
    const event = await GameEventService.getEventById(
      req.params.gameId,
      req.params.eventId,
      req.user!.id
    );

    res.json({
      success: true,
      event,
    });
  } catch (error) {
    logger.error('Error getting game event', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get game event' });
    }
  }
});

/**
 * DELETE /api/v1/games/:gameId/events/:eventId
 * Delete a game event
 */
router.delete('/:gameId/events/:eventId', validateUuidParams('gameId', 'eventId'), async (req, res) => {
  try {
    await GameEventService.deleteEvent(
      req.params.gameId,
      req.params.eventId,
      req.user!.id
    );

    res.json({
      success: true,
      message: 'Game event deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting game event', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete game event' });
    }
  }
});

// ============================================
// RSVP Routes
// ============================================

/**
 * POST /api/v1/games/:gameId/rsvp
 * Create or update an RSVP for a game
 */
router.post('/:gameId/rsvp', validateUuidParams('gameId'), async (req, res) => {
  try {
    const validationResult = upsertRsvpSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const rsvp = await RsvpService.upsertRsvp(
      req.params.gameId,
      req.user!.id,
      validationResult.data.status
    );

    res.json({
      success: true,
      rsvp,
    });
  } catch (error) {
    logger.error('Error upserting RSVP', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update RSVP' });
    }
  }
});

/**
 * GET /api/v1/games/:gameId/rsvps
 * Get all RSVPs for a game with summary counts
 */
router.get('/:gameId/rsvps', validateUuidParams('gameId'), async (req, res) => {
  try {
    const result = await RsvpService.getGameRsvps(
      req.params.gameId,
      req.user!.id
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Error getting RSVPs', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get RSVPs' });
    }
  }
});

export default router;
