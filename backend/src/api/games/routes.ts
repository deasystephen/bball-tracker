/**
 * Games API routes
 */

import { Router } from 'express';
import { GameService } from '../../services/game-service';
import { GameEventService } from '../../services/game-event-service';
import { RsvpService } from '../../services/rsvp-service';
import { StatsExportService } from '../../services/stats-export-service';
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
import { buildContentDisposition } from '../../utils/content-disposition';

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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
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
    const game = await GameService.getGameById(req.params.id as string, req.user!.id);

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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const game = await GameService.updateGame(
      req.params.id as string,
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
    await GameService.deleteGame(req.params.id as string, req.user!.id);

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
// Stats Export Routes
// ============================================

/**
 * GET /api/v1/games/:id/export.csv
 * Export full event log as CSV
 * Note: entitlement gating (Coach Premium) deferred to v2.2; open for now.
 */
router.get('/:id/export.csv', validateUuidParams('id'), async (req, res) => {
  try {
    const exportFile = await StatsExportService.exportGameEventsCsv(
      req.params.id as string,
      req.user!.id
    );

    res.setHeader('Content-Type', exportFile.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(exportFile.filename));

    exportFile.stream.on('error', (err) => {
      logger.error('Stream error in game CSV export', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to export game CSV' });
      } else {
        res.end();
      }
    });
    exportFile.stream.pipe(res);
  } catch (error) {
    logger.error('Error exporting game CSV', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to export game CSV' });
    }
  }
});

/**
 * GET /api/v1/games/:id/boxscore.pdf
 * Export box score as PDF
 * Note: entitlement gating (Coach Premium) deferred to v2.2; open for now.
 *
 * PERFORMANCE NOTE: PDFKit is synchronous/CPU-bound and will block the Node
 * event loop while rendering. At GA scale (many concurrent exports) this must
 * be moved off the main thread via worker_threads or a background job.
 * Tracked in issue #50.
 */
router.get('/:id/boxscore.pdf', validateUuidParams('id'), async (req, res) => {
  try {
    const exportFile = await StatsExportService.exportGameBoxScorePdf(
      req.params.id as string,
      req.user!.id
    );

    res.setHeader('Content-Type', exportFile.contentType);
    res.setHeader('Content-Disposition', buildContentDisposition(exportFile.filename));

    exportFile.stream.on('error', (err) => {
      logger.error('Stream error in game PDF export', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to export box score PDF' });
      } else {
        res.end();
      }
    });
    exportFile.stream.pipe(res);
  } catch (error) {
    logger.error('Error exporting box score PDF', { error: error instanceof Error ? error.message : String(error) });
    if (
      error instanceof NotFoundError ||
      error instanceof ForbiddenError ||
      error instanceof BadRequestError
    ) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to export box score PDF' });
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const event = await GameEventService.createEvent(
      req.params.gameId as string,
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await GameEventService.listEvents(
      req.params.gameId as string,
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
      req.params.gameId as string,
      req.params.eventId as string,
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
      req.params.gameId as string,
      req.params.eventId as string,
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const rsvp = await RsvpService.upsertRsvp(
      req.params.gameId as string,
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
      req.params.gameId as string,
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
