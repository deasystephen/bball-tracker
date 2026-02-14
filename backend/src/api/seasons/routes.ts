/**
 * Seasons API routes
 */

import { Router } from 'express';
import { SeasonService } from '../../services/season-service';
import { authenticate } from '../auth/middleware';
import {
  createSeasonSchema,
  updateSeasonSchema,
  seasonQuerySchema,
} from './schemas';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/seasons
 * Create a new season
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validationResult = createSeasonSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const season = await SeasonService.createSeason(validationResult.data, req.user!.id);

    res.status(201).json({
      success: true,
      season,
    });
  } catch (error) {
    logger.error('Error creating season', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof BadRequestError || error instanceof NotFoundError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create season' });
    }
  }
});

/**
 * GET /api/v1/seasons
 * List seasons with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = seasonQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const result = await SeasonService.listSeasons(validationResult.data);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Error listing seasons', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to list seasons' });
    }
  }
});

/**
 * GET /api/v1/seasons/:id
 * Get a season by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const season = await SeasonService.getSeasonById(req.params.id);

    res.json({
      success: true,
      season,
    });
  } catch (error) {
    logger.error('Error getting season', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof NotFoundError || error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to get season' });
    }
  }
});

/**
 * PATCH /api/v1/seasons/:id
 * Update a season
 */
router.patch('/:id', async (req, res) => {
  try {
    // Validate request body
    const validationResult = updateSeasonSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.errors.map((e) => e.message).join(', ')
      );
    }

    const season = await SeasonService.updateSeason(
      req.params.id,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      season,
    });
  } catch (error) {
    logger.error('Error updating season', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof NotFoundError || error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update season' });
    }
  }
});

/**
 * DELETE /api/v1/seasons/:id
 * Delete a season
 */
router.delete('/:id', async (req, res) => {
  try {
    await SeasonService.deleteSeason(req.params.id, req.user!.id);

    res.json({
      success: true,
      message: 'Season deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting season', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof NotFoundError || error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to delete season' });
    }
  }
});

export default router;
