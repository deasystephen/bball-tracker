/**
 * Players API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { PlayerService } from '../../src/services/player-service';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../src/utils/errors';

// Test UUIDs
const TEST_PLAYER_ID = 'b2c3d4e5-f6a7-8901-2345-67890abcdef0';

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
jest.mock('../../src/services/player-service');

const mockPlayerService = PlayerService as jest.Mocked<typeof PlayerService>;

describe('Players API', () => {
  const mockPlayer = {
    id: TEST_PLAYER_ID,
    email: 'player@example.com',
    name: 'John Player',
    role: 'PLAYER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/players', () => {
    it('should create a player successfully', async () => {
      mockPlayerService.createPlayer.mockResolvedValue(mockPlayer as any);

      const response = await request(app)
        .post('/api/v1/players')
        .send({
          email: 'player@example.com',
          name: 'John Player',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.player).toBeDefined();
      expect(mockPlayerService.createPlayer).toHaveBeenCalled();
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'player@example.com' }); // Missing name

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for invalid email', async () => {
      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'invalid-email', name: 'John Player' });

      expect(response.status).toBe(400);
    });

    it('should handle service errors', async () => {
      mockPlayerService.createPlayer.mockRejectedValue(
        new BadRequestError('Player with this email already exists')
      );

      const response = await request(app)
        .post('/api/v1/players')
        .send({
          email: 'player@example.com',
          name: 'John Player',
        });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/players', () => {
    it('should list players successfully', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/players');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.players).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should support search query', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ search: 'John' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'John' })
      );
    });

    it('should filter by role', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ role: 'PLAYER' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'PLAYER' })
      );
    });

    it('should support pagination', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 25, limit: 10, offset: 10, hasMore: true },
      } as any);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ limit: 10, offset: 10 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /api/v1/players/:id', () => {
    it('should get a player by ID', async () => {
      mockPlayerService.getPlayerById.mockResolvedValue(mockPlayer as any);

      const response = await request(app).get(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.player.id).toBe(TEST_PLAYER_ID);
    });

    it('should return 404 for non-existent player', async () => {
      mockPlayerService.getPlayerById.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app).get('/api/v1/players/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Player not found');
    });
  });

  describe('PATCH /api/v1/players/:id', () => {
    it('should update a player successfully', async () => {
      const updatedPlayer = { ...mockPlayer, name: 'Updated Name' };
      mockPlayerService.updatePlayer.mockResolvedValue(updatedPlayer as any);

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.player.name).toBe('Updated Name');
    });

    it('should return 400 for empty name', async () => {
      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: '' }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent player', async () => {
      mockPlayerService.updatePlayer.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app)
        .patch('/api/v1/players/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized update', async () => {
      mockPlayerService.updatePlayer.mockRejectedValue(
        new ForbiddenError('Not authorized to update this player')
      );

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/players/:id', () => {
    it('should delete a player successfully', async () => {
      mockPlayerService.deletePlayer.mockResolvedValue(undefined as any);

      const response = await request(app).delete(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Player deleted successfully');
    });

    it('should return 404 for non-existent player', async () => {
      mockPlayerService.deletePlayer.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app).delete('/api/v1/players/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized delete', async () => {
      mockPlayerService.deletePlayer.mockRejectedValue(
        new ForbiddenError('Not authorized to delete this player')
      );

      const response = await request(app).delete(`/api/v1/players/${TEST_PLAYER_ID}`);

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
