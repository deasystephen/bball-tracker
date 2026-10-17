/**
 * Stats API routes
 */

import { Router } from 'express';
import { StatsService } from '../../services/stats-service';
import { authenticate } from '../auth/middleware';
import { validateUuidParams } from '../middleware/validate-params';
import { respondWithError } from '../../utils/respond-with-error';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/v1/stats/games/:gameId
 * Get box score for a game
 */
router.get('/games/:gameId', validateUuidParams('gameId'), async (req, res) => {
  try {
    const boxScore = await StatsService.getBoxScore(req.params.gameId as string, req.user!.id);

    res.json({
      success: true,
      boxScore,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting box score', fallback: 'Failed to get box score' });
  }
});

/**
 * GET /api/v1/stats/games/:gameId/players/:playerId
 * Get player's stats for a specific game
 */
router.get('/games/:gameId/players/:playerId', validateUuidParams('gameId', 'playerId'), async (req, res) => {
  try {
    const stats = await StatsService.getPlayerGameStats(
      req.params.gameId as string,
      req.params.playerId as string,
      req.user!.id
    );

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting player game stats', fallback: 'Failed to get player game stats' });
  }
});

/**
 * GET /api/v1/stats/players/:playerId
 * Get player's overall stats across all teams
 */
router.get('/players/:playerId', validateUuidParams('playerId'), async (req, res) => {
  try {
    const stats = await StatsService.getPlayerOverallStats(
      req.params.playerId as string,
      req.user!.id
    );

    res.json({
      success: true,
      ...stats,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting player overall stats', fallback: 'Failed to get player stats' });
  }
});

/**
 * GET /api/v1/stats/players/:playerId/teams/:teamId
 * Get player's season stats for a specific team
 */
router.get('/players/:playerId/teams/:teamId', validateUuidParams('playerId', 'teamId'), async (req, res) => {
  try {
    const stats = await StatsService.getPlayerSeasonStats(
      req.params.playerId as string,
      req.params.teamId as string,
      req.user!.id
    );

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting player season stats', fallback: 'Failed to get player season stats' });
  }
});

/**
 * GET /api/v1/stats/teams/:teamId
 * Get team's season stats
 */
router.get('/teams/:teamId', validateUuidParams('teamId'), async (req, res) => {
  try {
    const stats = await StatsService.getTeamSeasonStats(
      req.params.teamId as string,
      req.user!.id
    );

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting team season stats', fallback: 'Failed to get team season stats' });
  }
});

/**
 * GET /api/v1/stats/teams/:teamId/players
 * Get roster with player season stats for a team
 */
router.get('/teams/:teamId/players', validateUuidParams('teamId'), async (req, res) => {
  try {
    const players = await StatsService.getTeamRosterStats(
      req.params.teamId as string,
      req.user!.id
    );

    res.json({
      success: true,
      players,
    });
  } catch (error) {
    respondWithError(res, error, { log: 'Error getting team roster stats', fallback: 'Failed to get team roster stats' });
  }
});

export default router;
