/**
 * Games API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { GameService } from '../../src/services/game-service';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../src/utils/errors';

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-8901-2345-67890abcdef0';
const TEST_GAME_ID = 'c3d4e5f6-a7b8-9012-3456-7890abcdef01';

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
jest.mock('../../src/services/game-service');

const mockGameService = GameService as jest.Mocked<typeof GameService>;

describe('Games API', () => {
  const mockGame = {
    id: TEST_GAME_ID,
    teamId: TEST_TEAM_ID,
    opponent: 'Celtics',
    date: new Date('2024-03-15T18:00:00Z'),
    status: 'SCHEDULED',
    homeScore: 0,
    awayScore: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    team: {
      id: TEST_TEAM_ID,
      name: 'Lakers',
      coach: { id: TEST_USER_ID, name: 'Test User' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/games', () => {
    it('should create a game successfully', async () => {
      mockGameService.createGame.mockResolvedValue(mockGame as any);

      const response = await request(app)
        .post('/api/v1/games')
        .send({
          teamId: TEST_TEAM_ID,
          opponent: 'Celtics',
          date: '2024-03-15T18:00:00Z',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.game).toBeDefined();
      expect(mockGameService.createGame).toHaveBeenCalled();
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/games')
        .send({ teamId: TEST_TEAM_ID }); // Missing opponent and date

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should handle service errors', async () => {
      mockGameService.createGame.mockRejectedValue(
        new ForbiddenError('Not authorized to create games for this team')
      );

      const response = await request(app)
        .post('/api/v1/games')
        .send({
          teamId: TEST_TEAM_ID,
          opponent: 'Celtics',
          date: '2024-03-15T18:00:00Z',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/games', () => {
    it('should list games successfully', async () => {
      mockGameService.listGames.mockResolvedValue({
        games: [mockGame],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/games');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.games).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should filter games by teamId', async () => {
      mockGameService.listGames.mockResolvedValue({
        games: [mockGame],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/games')
        .query({ teamId: TEST_TEAM_ID });

      expect(response.status).toBe(200);
      expect(mockGameService.listGames).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: TEST_TEAM_ID }),
        TEST_USER_ID
      );
    });

    it('should filter games by status', async () => {
      mockGameService.listGames.mockResolvedValue({
        games: [mockGame],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/games')
        .query({ status: 'SCHEDULED' });

      expect(response.status).toBe(200);
      expect(mockGameService.listGames).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'SCHEDULED' }),
        TEST_USER_ID
      );
    });

    it('should support pagination', async () => {
      mockGameService.listGames.mockResolvedValue({
        games: [mockGame],
        pagination: { total: 25, limit: 10, offset: 10, hasMore: true },
      } as any);

      const response = await request(app)
        .get('/api/v1/games')
        .query({ limit: 10, offset: 10 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /api/v1/games/:id', () => {
    it('should get a game by ID', async () => {
      mockGameService.getGameById.mockResolvedValue(mockGame as any);

      const response = await request(app).get(`/api/v1/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.game.id).toBe(TEST_GAME_ID);
    });

    it('should return 404 for non-existent game', async () => {
      mockGameService.getGameById.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app).get('/api/v1/games/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game not found');
    });

    it('should return 403 for forbidden access', async () => {
      mockGameService.getGameById.mockRejectedValue(new ForbiddenError('Access denied'));

      const response = await request(app).get(`/api/v1/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });
  });

  describe('PATCH /api/v1/games/:id', () => {
    it('should update a game successfully', async () => {
      const updatedGame = { ...mockGame, opponent: 'Bulls' };
      mockGameService.updateGame.mockResolvedValue(updatedGame as any);

      const response = await request(app)
        .patch(`/api/v1/games/${TEST_GAME_ID}`)
        .send({ opponent: 'Bulls' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.game.opponent).toBe('Bulls');
    });

    it('should update game status', async () => {
      const updatedGame = { ...mockGame, status: 'IN_PROGRESS' };
      mockGameService.updateGame.mockResolvedValue(updatedGame as any);

      const response = await request(app)
        .patch(`/api/v1/games/${TEST_GAME_ID}`)
        .send({ status: 'IN_PROGRESS' });

      expect(response.status).toBe(200);
      expect(response.body.game.status).toBe('IN_PROGRESS');
    });

    it('should update game scores', async () => {
      const updatedGame = { ...mockGame, homeScore: 45, awayScore: 42 };
      mockGameService.updateGame.mockResolvedValue(updatedGame as any);

      const response = await request(app)
        .patch(`/api/v1/games/${TEST_GAME_ID}`)
        .send({ homeScore: 45, awayScore: 42 });

      expect(response.status).toBe(200);
      expect(response.body.game.homeScore).toBe(45);
      expect(response.body.game.awayScore).toBe(42);
    });

    it('should return 400 for invalid update data', async () => {
      const response = await request(app)
        .patch(`/api/v1/games/${TEST_GAME_ID}`)
        .send({ homeScore: -5 }); // Invalid negative score

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent game', async () => {
      mockGameService.updateGame.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app)
        .patch('/api/v1/games/00000000-0000-0000-0000-000000000000')
        .send({ opponent: 'Bulls' });

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized update', async () => {
      mockGameService.updateGame.mockRejectedValue(
        new ForbiddenError('Not authorized to update this game')
      );

      const response = await request(app)
        .patch(`/api/v1/games/${TEST_GAME_ID}`)
        .send({ opponent: 'Bulls' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/games/:id', () => {
    it('should delete a game successfully', async () => {
      mockGameService.deleteGame.mockResolvedValue(undefined as any);

      const response = await request(app).delete(`/api/v1/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Game deleted successfully');
    });

    it('should return 404 for non-existent game', async () => {
      mockGameService.deleteGame.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app).delete('/api/v1/games/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized delete', async () => {
      mockGameService.deleteGame.mockRejectedValue(
        new ForbiddenError('Not authorized to delete this game')
      );

      const response = await request(app).delete(`/api/v1/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(403);
    });

    it('should return 400 for game in progress', async () => {
      mockGameService.deleteGame.mockRejectedValue(
        new BadRequestError('Cannot delete game in progress')
      );

      const response = await request(app).delete(`/api/v1/games/${TEST_GAME_ID}`);

      expect(response.status).toBe(400);
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
