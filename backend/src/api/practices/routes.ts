/**
 * Practice scheduling routes (#33). Two routers:
 *
 *   /api/v1/practices          single sessions and per-session availability
 *   /api/v1/practice-series    recurring series
 *
 * Creating a practice or a series sits behind the PRACTICE_SCHEDULING
 * entitlement, which every tier has (FREE since 2026-11-15, #33); the gate
 * stays mounted so a paid tier is a one-line change in
 * services/entitlements. Editing, cancelling and deleting what exists are
 * never gated. Detail: docs/architecture/practice-scheduling.md.
 */

import { Request, Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { validateUuidParams } from '../middleware/validate-params';
import { requireEntitlement } from '../middleware/entitlements';
import { Feature } from '../../services/entitlements';
import { PracticeService } from '../../services/practice-service';
import { PracticeSeriesService } from '../../services/practice-series-service';
import { BadRequestError } from '../../utils/errors';
import { respondWithError } from '../../utils/respond-with-error';
import {
  cancelPracticeSchema,
  createPracticeSchema,
  createPracticeSeriesSchema,
  practiceQuerySchema,
  updatePracticeSchema,
  updatePracticeSeriesSchema,
  upsertAvailabilitySchema,
} from './schemas';

/** Parses `input` or throws a 400 naming every issue. */
function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestError(result.error.issues.map((issue) => issue.message).join(', '));
  }
  return result.data;
}

const userIdOf = (req: Request): string => req.user!.id;

// ============================================
// /practices
// ============================================

export const practiceRouter = Router();
practiceRouter.use(authenticate);

/** POST /api/v1/practices: create one practice. */
practiceRouter.post('/', requireEntitlement(Feature.PRACTICE_SCHEDULING), async (req, res) => {
  try {
    const practice = await PracticeService.createPractice(parse(createPracticeSchema, req.body), userIdOf(req));
    res.status(201).json({ success: true, practice });
  } catch (error) {
    respondWithError(res, error, { log: 'Error creating practice', fallback: 'Failed to create practice' });
  }
});

/** GET /api/v1/practices: sessions the caller may read, soonest first. */
practiceRouter.get('/', async (req, res) => {
  try {
    const result = await PracticeService.listPractices(parse(practiceQuerySchema, req.query), userIdOf(req));
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, { log: 'Error listing practices', fallback: 'Failed to list practices' });
  }
});

/** GET /api/v1/practices/:id */
practiceRouter.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const practice = await PracticeService.getPractice(req.params.id as string, userIdOf(req));
    res.json({ success: true, practice });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting practice', fallback: 'Failed to get practice' });
  }
});

/** PATCH /api/v1/practices/:id: edit one session (an exception when it belongs to a series). */
practiceRouter.patch('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const practice = await PracticeService.updatePractice(
      req.params.id as string,
      parse(updatePracticeSchema, req.body),
      userIdOf(req)
    );
    res.json({ success: true, practice });
  } catch (error) {
    respondWithError(res, error, { log: 'Error updating practice', fallback: 'Failed to update practice' });
  }
});

/** POST /api/v1/practices/:id/cancel */
practiceRouter.post('/:id/cancel', validateUuidParams('id'), async (req, res) => {
  try {
    const practice = await PracticeService.cancelPractice(
      req.params.id as string,
      parse(cancelPracticeSchema, req.body ?? {}),
      userIdOf(req)
    );
    res.json({ success: true, practice });
  } catch (error) {
    respondWithError(res, error, { log: 'Error cancelling practice', fallback: 'Failed to cancel practice' });
  }
});

/** DELETE /api/v1/practices/:id */
practiceRouter.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    await PracticeService.deletePractice(req.params.id as string, userIdOf(req));
    res.json({ success: true, message: 'Practice deleted successfully' });
  } catch (error) {
    respondWithError(res, error, { log: 'Error deleting practice', fallback: 'Failed to delete practice' });
  }
});

/** PUT /api/v1/practices/:id/availability: my (or my child's) answer. */
practiceRouter.put('/:id/availability', validateUuidParams('id'), async (req, res) => {
  try {
    const availability = await PracticeService.upsertAvailability(
      req.params.id as string,
      userIdOf(req),
      parse(upsertAvailabilitySchema, req.body)
    );
    res.json({ success: true, availability });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error updating practice availability',
      fallback: 'Failed to update availability',
    });
  }
});

/** GET /api/v1/practices/:id/availability: every answer plus the counts. */
practiceRouter.get('/:id/availability', validateUuidParams('id'), async (req, res) => {
  try {
    const result = await PracticeService.getAvailability(req.params.id as string, userIdOf(req));
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error getting practice availability',
      fallback: 'Failed to get availability',
    });
  }
});

// ============================================
// /practice-series
// ============================================

export const practiceSeriesRouter = Router();
practiceSeriesRouter.use(authenticate);

/** POST /api/v1/practice-series: create a recurring series and its sessions. */
practiceSeriesRouter.post('/', requireEntitlement(Feature.PRACTICE_SCHEDULING), async (req, res) => {
  try {
    const series = await PracticeSeriesService.createSeries(
      parse(createPracticeSeriesSchema, req.body),
      userIdOf(req)
    );
    res.status(201).json({ success: true, series });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error creating practice series',
      fallback: 'Failed to create practice series',
    });
  }
});

/** GET /api/v1/practice-series/:id */
practiceSeriesRouter.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const series = await PracticeSeriesService.getSeries(req.params.id as string, userIdOf(req));
    res.json({ success: true, series });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting practice series', fallback: 'Failed to get practice series' });
  }
});

/** PATCH /api/v1/practice-series/:id: edit every future, non-exception session. */
practiceSeriesRouter.patch('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const result = await PracticeSeriesService.updateSeries(
      req.params.id as string,
      parse(updatePracticeSeriesSchema, req.body),
      userIdOf(req)
    );
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error updating practice series',
      fallback: 'Failed to update practice series',
    });
  }
});

/** DELETE /api/v1/practice-series/:id: cancel the series, delete its future sessions. */
practiceSeriesRouter.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const result = await PracticeSeriesService.cancelSeries(req.params.id as string, userIdOf(req));
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error cancelling practice series',
      fallback: 'Failed to cancel practice series',
    });
  }
});
