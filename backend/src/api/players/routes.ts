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
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { validateUuidParams } from '../middleware/validate-params';
import { AccountService } from '../../services/account-service';
import { isGuardianOf } from '../../utils/permissions';
import prisma from '../../models';
import { respondWithError } from '../../utils/respond-with-error';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/players
 * Create a new player account for an email. ADMIN or roster-managing staff
 * only (403 otherwise); 409 if the email is taken concurrently.
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validationResult = createPlayerSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const player = await PlayerService.createPlayer(validationResult.data, {
      id: req.user!.id,
      role: req.user!.role,
    });

    res.status(201).json({
      success: true,
      player,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error creating player', fallback: 'Failed to create player' });
  }
});

/**
 * GET /api/v1/players
 * List players with optional filters. Non-admins only see players sharing a
 * team with them (and themselves), without `email`; `role` / `isManaged`
 * are admin-only filters. See PlayerService.listPlayers.
 */
router.get('/', async (req, res) => {
  try {
    // Validate query parameters
    const validationResult = playerQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await PlayerService.listPlayers(validationResult.data, {
      id: req.user!.id,
      role: req.user!.role,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error listing players', fallback: 'Failed to list players' });
  }
});

/**
 * GET /api/v1/players/:id
 * Get a player by ID. Non-admins get 404 for players outside their teams.
 */
router.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const player = await PlayerService.getPlayerById(req.params.id as string, {
      id: req.user!.id,
      role: req.user!.role,
    });

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting player', fallback: 'Failed to get player' });
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
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const player = await PlayerService.updatePlayer(
      req.params.id as string,
      validationResult.data,
      req.user!.id
    );

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error updating player', fallback: 'Failed to update player' });
  }
});

/**
 * DELETE /api/v1/players/:id
 * Delete a player
 */
router.delete('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    await PlayerService.deletePlayer(req.params.id as string, req.user!.id);

    res.json({
      success: true,
      message: 'Player deleted successfully',
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error deleting player', fallback: 'Failed to delete player' });
  }
});

/**
 * DELETE /api/v1/players/:id/account
 * A guardian deletes a managed child's record (#444, D5).
 *
 * Allowed only when the caller is a guardian of `:id` AND the child is a
 * managed, unclaimed record (`isManaged`, no login). A claimed account can be
 * deleted only by its owner via `DELETE /auth/me` — not by guardians, not by
 * ADMINs through the API. The route pre-checks; the service re-checks under
 * the row lock. Anonymize-in-place, or erased outright when nothing references
 * the row (#529): see `AccountService.deleteAccount`. 200 `{ success, erased }`.
 */
router.delete('/:id/account', validateUuidParams('id'), async (req, res) => {
  try {
    const childId = req.params.id as string;
    if (!(await isGuardianOf(req.user!.id, childId))) {
      throw new ForbiddenError('You are not a guardian of this player');
    }
    const child = await prisma.user.findUnique({
      where: { id: childId },
      select: { isManaged: true, workosUserId: true, deletedAt: true },
    });
    if (!child || child.deletedAt !== null) {
      throw new NotFoundError('Player not found');
    }
    if (!child.isManaged || child.workosUserId !== null) {
      throw new ForbiddenError('Only the account owner can delete a claimed account');
    }
    const result = await AccountService.deleteAccount(childId, { actorId: req.user!.id, mode: 'guardian' });
    res.json({ success: true, erased: result.erased });
  } catch (error) {
    respondWithError(res, error, { log: 'Error deleting player account', fallback: 'Failed to delete player account' });
  }
});

export default router;
