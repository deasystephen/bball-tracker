/**
 * Calendar feed routes for a team.
 *
 *   GET  /api/v1/teams/:id/calendar.ics?token=... (public, token-auth)
 *   POST /api/v1/teams/:id/calendar/subscribe    (authenticated)
 *   POST /api/v1/teams/:id/calendar/revoke       (authenticated)
 */

import { Router } from 'express';
import { CalendarService } from '../../services/calendar-service';
import { authenticate } from '../auth/middleware';
import { validateUuidParams } from '../middleware/validate-params';
import { calendarFeedRateLimit } from '../middleware/rate-limit';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  AppError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router({ mergeParams: true });

/**
 * GET /api/v1/teams/:id/calendar.ics
 *
 * Public: calendar clients can't send Authorization headers, so auth is
 * via an opaque `token` query parameter bound to a specific (user, team).
 */
router.get(
  '/:id/calendar.ics',
  calendarFeedRateLimit,
  validateUuidParams('id'),
  async (req, res) => {
  try {
    const teamId = req.params.id as string;
    const token = typeof req.query.token === 'string' ? req.query.token : '';

    // Resolve + authorize the token. Throws ForbiddenError on revoked,
    // mismatched, or stale tokens.
    await CalendarService.resolveToken(teamId, token);

    const icsText = await CalendarService.buildFeed(teamId);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="team-${teamId}.ics"`
    );
    // Calendar clients re-fetch periodically; discourage caching so edits appear quickly.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(icsText);
  } catch (error) {
    logger.error('Error serving calendar feed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to generate calendar feed' });
    }
  }
  }
);

// All management endpoints require authentication.
router.use(authenticate);

/**
 * POST /api/v1/teams/:id/calendar/subscribe
 * Returns (and creates if missing) the user's feed URL for this team.
 */
router.post(
  '/:id/calendar/subscribe',
  validateUuidParams('id'),
  async (req, res) => {
    try {
      const result = await CalendarService.subscribe(
        req.params.id as string,
        req.user!.id
      );

      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Error subscribing to calendar feed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (
        error instanceof NotFoundError ||
        error instanceof ForbiddenError ||
        error instanceof BadRequestError
      ) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to subscribe to calendar feed' });
      }
    }
  }
);

/**
 * POST /api/v1/teams/:id/calendar/revoke
 * Invalidates all of the user's calendar feed tokens for this team.
 */
router.post(
  '/:id/calendar/revoke',
  validateUuidParams('id'),
  async (req, res) => {
    try {
      const result = await CalendarService.revoke(
        req.params.id as string,
        req.user!.id
      );

      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Error revoking calendar feed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (
        error instanceof NotFoundError ||
        error instanceof ForbiddenError ||
        error instanceof BadRequestError
      ) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to revoke calendar feed' });
      }
    }
  }
);

export default router;
