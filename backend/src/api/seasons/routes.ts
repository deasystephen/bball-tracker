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
import { BadRequestError } from '../../utils/errors';
import { respondWithError } from '../../utils/respond-with-error';

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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const season = await SeasonService.createSeason(validationResult.data, req.user!.id);

    res.status(201).json({
      success: true,
      season,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error creating season', fallback: 'Failed to create season' });
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await SeasonService.listSeasons(validationResult.data, {
      id: req.user!.id,
      role: req.user!.role,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error listing seasons', fallback: 'Failed to list seasons' });
  }
});

/**
 * GET /api/v1/seasons/:id
 * Get a season by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const season = await SeasonService.getSeasonById(req.params.id, req.user!.id);

    res.json({
      success: true,
      season,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting season', fallback: 'Failed to get season' });
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
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
    respondWithError(res, error, { log: 'Error updating season', fallback: 'Failed to update season' });
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
    respondWithError(res, error, { log: 'Error deleting season', fallback: 'Failed to delete season' });
  }
});

export default router;
