/**
 * Stats API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { StatsService } from '../../src/services/stats-service';
import { NotFoundError, ForbiddenError } from '../../src/utils/errors';

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-8901-2345-67890abcdef0';
const TEST_GAME_ID = 'c3d4e5f6-a7b8-9012-3456-7890abcdef01';
const TEST_PLAYER_ID = 'd4e5f6a7-b8c9-0123-4567-890abcdef012';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the service
jest.mock('../../src/services/stats-service');

const mockStatsService = StatsService as jest.Mocked<typeof StatsService>;

describe('Stats API', () => {
  const mockBoxScore = {
    game: {
      id: TEST_GAME_ID,
      date: '2024-03-15T18:00:00.000Z',
      status: 'FINISHED',
      homeScore: 85,
      awayScore: 78,
      opponent: 'Celtics',
    },
    team: {
      id: TEST_TEAM_ID,
      name: 'Lakers',
      stats: {
        teamId: TEST_TEAM_ID,
        teamName: 'Lakers',
        points: 85,
        rebounds: 42,
        assists: 23,
        steals: 8,
        blocks: 5,
        turnovers: 12,
        fouls: 18,
        fieldGoalsMade: 32,
        fieldGoalsAttempted: 70,
        fieldGoalPercentage: 45.7,
        threePointersMade: 10,
        threePointersAttempted: 28,
        threePointPercentage: 35.7,
        freeThrowsMade: 11,
        freeThrowsAttempted: 14,
        freeThrowPercentage: 78.6,
      },
      players: [
        {
          playerId: TEST_PLAYER_ID,
          playerName: 'John Doe',
          jerseyNumber: 23,
          position: 'Guard',
          points: 25,
          rebounds: 5,
          offensiveRebounds: 1,
          defensiveRebounds: 4,
          assists: 7,
          steals: 2,
          blocks: 1,
          turnovers: 3,
          fouls: 2,
          fieldGoalsMade: 9,
          fieldGoalsAttempted: 18,
          fieldGoalPercentage: 50.0,
          threePointersMade: 3,
          threePointersAttempted: 7,
          threePointPercentage: 42.9,
          freeThrowsMade: 4,
          freeThrowsAttempted: 5,
          freeThrowPercentage: 80.0,
        },
      ],
    },
  };

  const mockPlayerGameStats = {
    playerId: TEST_PLAYER_ID,
    playerName: 'John Doe',
    jerseyNumber: 23,
    position: 'Guard',
    points: 25,
    rebounds: 5,
    assists: 7,
    steals: 2,
    blocks: 1,
    turnovers: 3,
    fouls: 2,
    fieldGoalsMade: 9,
    fieldGoalsAttempted: 18,
    fieldGoalPercentage: 50.0,
    threePointersMade: 3,
    threePointersAttempted: 7,
    threePointPercentage: 42.9,
    freeThrowsMade: 4,
    freeThrowsAttempted: 5,
    freeThrowPercentage: 80.0,
    offensiveRebounds: 1,
    defensiveRebounds: 4,
  };

  const mockPlayerSeasonStats = {
    ...mockPlayerGameStats,
    gamesPlayed: 10,
    pointsPerGame: 22.5,
    reboundsPerGame: 6.2,
    assistsPerGame: 5.8,
    stealsPerGame: 1.5,
    blocksPerGame: 0.8,
    turnoversPerGame: 2.5,
    efficiency: 25.3,
  };

  const mockTeamSeasonStats = {
    teamId: TEST_TEAM_ID,
    teamName: 'Lakers',
    gamesPlayed: 15,
    wins: 10,
    losses: 5,
    pointsPerGame: 88.5,
    reboundsPerGame: 44.2,
    assistsPerGame: 24.5,
    turnoversPerGame: 13.2,
    fieldGoalPercentage: 46.5,
    threePointPercentage: 36.2,
    freeThrowPercentage: 78.5,
    recentGames: [
      {
        id: TEST_GAME_ID,
        date: '2024-03-15T18:00:00.000Z',
        opponent: 'Celtics',
        homeScore: 85,
        awayScore: 78,
        result: 'W' as const,
      },
    ],
  };

  const mockPlayerOverallStats = {
    player: { id: TEST_PLAYER_ID, name: 'John Doe' },
    teams: [
      {
        teamId: TEST_TEAM_ID,
        teamName: 'Lakers',
        seasonName: 'NBA - Spring 2024',
        stats: mockPlayerSeasonStats,
      },
    ],
    careerTotals: mockPlayerSeasonStats,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/stats/games/:gameId', () => {
    it('should return box score for a game', async () => {
      mockStatsService.getBoxScore.mockResolvedValue(mockBoxScore);

      const response = await request(app).get(`/api/v1/stats/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.boxScore).toBeDefined();
      expect(response.body.boxScore.game.id).toBe(TEST_GAME_ID);
      expect(response.body.boxScore.team.players).toHaveLength(1);
      expect(mockStatsService.getBoxScore).toHaveBeenCalledWith(TEST_GAME_ID, TEST_USER_ID);
    });

    it('should return 404 for non-existent game', async () => {
      mockStatsService.getBoxScore.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app).get('/api/v1/stats/games/non-existent');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game not found');
    });

    it('should return 403 for forbidden access', async () => {
      mockStatsService.getBoxScore.mockRejectedValue(new ForbiddenError('Access denied'));

      const response = await request(app).get(`/api/v1/stats/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });
  });

  describe('GET /api/v1/stats/games/:gameId/players/:playerId', () => {
    it('should return player stats for a game', async () => {
      mockStatsService.getPlayerGameStats.mockResolvedValue(mockPlayerGameStats);

      const response = await request(app).get(
        `/api/v1/stats/games/${TEST_GAME_ID}/players/${TEST_PLAYER_ID}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.stats).toBeDefined();
      expect(response.body.stats.playerId).toBe(TEST_PLAYER_ID);
      expect(response.body.stats.points).toBe(25);
      expect(mockStatsService.getPlayerGameStats).toHaveBeenCalledWith(
        TEST_GAME_ID,
        TEST_PLAYER_ID,
        TEST_USER_ID
      );
    });

    it('should return 404 for non-existent player stats', async () => {
      mockStatsService.getPlayerGameStats.mockRejectedValue(
        new NotFoundError('Player stats not found for this game')
      );

      const response = await request(app).get(
        `/api/v1/stats/games/${TEST_GAME_ID}/players/non-existent`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/stats/players/:playerId', () => {
    it('should return player overall stats', async () => {
      mockStatsService.getPlayerOverallStats.mockResolvedValue(mockPlayerOverallStats);

      const response = await request(app).get(`/api/v1/stats/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.player).toBeDefined();
      expect(response.body.player.id).toBe(TEST_PLAYER_ID);
      expect(response.body.teams).toHaveLength(1);
      expect(response.body.careerTotals).toBeDefined();
      expect(mockStatsService.getPlayerOverallStats).toHaveBeenCalledWith(
        TEST_PLAYER_ID,
        TEST_USER_ID
      );
    });

    it('should return 404 for non-existent player', async () => {
      mockStatsService.getPlayerOverallStats.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app).get('/api/v1/stats/players/non-existent');

      expect(response.status).toBe(404);
    });

    it('should return 403 for forbidden access', async () => {
      mockStatsService.getPlayerOverallStats.mockRejectedValue(
        new ForbiddenError('You do not have access to this player\'s teams')
      );

      const response = await request(app).get(`/api/v1/stats/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/stats/players/:playerId/teams/:teamId', () => {
    it('should return player season stats for a team', async () => {
      mockStatsService.getPlayerSeasonStats.mockResolvedValue(mockPlayerSeasonStats);

      const response = await request(app).get(
        `/api/v1/stats/players/${TEST_PLAYER_ID}/teams/${TEST_TEAM_ID}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.stats).toBeDefined();
      expect(response.body.stats.playerId).toBe(TEST_PLAYER_ID);
      expect(response.body.stats.gamesPlayed).toBe(10);
      expect(response.body.stats.pointsPerGame).toBe(22.5);
      expect(mockStatsService.getPlayerSeasonStats).toHaveBeenCalledWith(
        TEST_PLAYER_ID,
        TEST_TEAM_ID,
        TEST_USER_ID
      );
    });

    it('should return 403 for forbidden access', async () => {
      mockStatsService.getPlayerSeasonStats.mockRejectedValue(
        new ForbiddenError('You do not have access to this team')
      );

      const response = await request(app).get(
        `/api/v1/stats/players/${TEST_PLAYER_ID}/teams/${TEST_TEAM_ID}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/stats/teams/:teamId', () => {
    it('should return team season stats', async () => {
      mockStatsService.getTeamSeasonStats.mockResolvedValue(mockTeamSeasonStats);

      const response = await request(app).get(`/api/v1/stats/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.stats).toBeDefined();
      expect(response.body.stats.teamId).toBe(TEST_TEAM_ID);
      expect(response.body.stats.gamesPlayed).toBe(15);
      expect(response.body.stats.wins).toBe(10);
      expect(response.body.stats.losses).toBe(5);
      expect(response.body.stats.recentGames).toHaveLength(1);
      expect(mockStatsService.getTeamSeasonStats).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_USER_ID);
    });

    it('should return 404 for non-existent team', async () => {
      mockStatsService.getTeamSeasonStats.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app).get('/api/v1/stats/teams/non-existent');

      expect(response.status).toBe(404);
    });

    it('should return 403 for forbidden access', async () => {
      mockStatsService.getTeamSeasonStats.mockRejectedValue(
        new ForbiddenError('You do not have access to this team')
      );

      const response = await request(app).get(`/api/v1/stats/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/stats/teams/:teamId/players', () => {
    it('should return roster with player season stats', async () => {
      mockStatsService.getTeamRosterStats.mockResolvedValue([mockPlayerSeasonStats]);

      const response = await request(app).get(`/api/v1/stats/teams/${TEST_TEAM_ID}/players`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.players).toBeDefined();
      expect(response.body.players).toHaveLength(1);
      expect(response.body.players[0].playerId).toBe(TEST_PLAYER_ID);
      expect(mockStatsService.getTeamRosterStats).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_USER_ID);
    });

    it('should return empty array for team with no players', async () => {
      mockStatsService.getTeamRosterStats.mockResolvedValue([]);

      const response = await request(app).get(`/api/v1/stats/teams/${TEST_TEAM_ID}/players`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.players).toHaveLength(0);
    });

    it('should return 403 for forbidden access', async () => {
      mockStatsService.getTeamRosterStats.mockRejectedValue(
        new ForbiddenError('You do not have access to this team')
      );

      const response = await request(app).get(`/api/v1/stats/teams/${TEST_TEAM_ID}/players`);

      expect(response.status).toBe(403);
    });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
