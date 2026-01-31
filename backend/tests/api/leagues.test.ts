/**
 * Leagues API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { LeagueService } from '../../src/services/league-service';
import { NotFoundError, BadRequestError } from '../../src/utils/errors';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the service
jest.mock('../../src/services/league-service');

const mockLeagueService = LeagueService as jest.Mocked<typeof LeagueService>;

describe('Leagues API', () => {
  const mockLeague = {
    id: 'league-1',
    name: 'Spring League',
    createdAt: new Date(),
    updatedAt: new Date(),
    seasons: [],
    admins: [],
    _count: { seasons: 0 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/leagues', () => {
    it('should create a league successfully', async () => {
      mockLeagueService.createLeague.mockResolvedValue(mockLeague as any);

      const response = await request(app)
        .post('/api/v1/leagues')
        .send({ name: 'Spring League' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.league).toBeDefined();
      expect(response.body.league.name).toBe('Spring League');
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/leagues')
        .send({}); // Missing name

      expect(response.status).toBe(400);
    });

    it('should return 400 for empty name', async () => {
      const response = await request(app)
        .post('/api/v1/leagues')
        .send({ name: '' }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should handle service errors', async () => {
      mockLeagueService.createLeague.mockRejectedValue(
        new BadRequestError('League already exists')
      );

      const response = await request(app)
        .post('/api/v1/leagues')
        .send({ name: 'Spring League' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/leagues', () => {
    it('should list leagues successfully', async () => {
      mockLeagueService.listLeagues.mockResolvedValue({
        leagues: [mockLeague],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/leagues');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.leagues).toHaveLength(1);
    });

    it('should filter leagues by search term', async () => {
      mockLeagueService.listLeagues.mockResolvedValue({
        leagues: [mockLeague],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/leagues')
        .query({ search: 'Spring' });

      expect(response.status).toBe(200);
      expect(mockLeagueService.listLeagues).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Spring' })
      );
    });

    it('should support pagination', async () => {
      mockLeagueService.listLeagues.mockResolvedValue({
        leagues: [mockLeague],
        pagination: { total: 25, limit: 10, offset: 10, hasMore: true },
      } as any);

      const response = await request(app)
        .get('/api/v1/leagues')
        .query({ limit: 10, offset: 10 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /api/v1/leagues/:id', () => {
    it('should get a league by ID', async () => {
      mockLeagueService.getLeagueById.mockResolvedValue(mockLeague as any);

      const response = await request(app).get('/api/v1/leagues/league-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.league.id).toBe('league-1');
    });

    it('should return 404 for non-existent league', async () => {
      mockLeagueService.getLeagueById.mockRejectedValue(new NotFoundError('League not found'));

      const response = await request(app).get('/api/v1/leagues/invalid-id');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('League not found');
    });
  });

  describe('PATCH /api/v1/leagues/:id', () => {
    it('should update a league successfully', async () => {
      const updatedLeague = { ...mockLeague, name: 'Updated League' };
      mockLeagueService.updateLeague.mockResolvedValue(updatedLeague as any);

      const response = await request(app)
        .patch('/api/v1/leagues/league-1')
        .send({ name: 'Updated League' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.league.name).toBe('Updated League');
    });

    it('should return 400 for invalid update data', async () => {
      const response = await request(app)
        .patch('/api/v1/leagues/league-1')
        .send({ name: '' }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent league', async () => {
      mockLeagueService.updateLeague.mockRejectedValue(new NotFoundError('League not found'));

      const response = await request(app)
        .patch('/api/v1/leagues/invalid-id')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/leagues/:id', () => {
    it('should delete a league successfully', async () => {
      mockLeagueService.deleteLeague.mockResolvedValue(undefined as any);

      const response = await request(app).delete('/api/v1/leagues/league-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('League deleted successfully');
    });

    it('should return 404 for non-existent league', async () => {
      mockLeagueService.deleteLeague.mockRejectedValue(new NotFoundError('League not found'));

      const response = await request(app).delete('/api/v1/leagues/invalid-id');

      expect(response.status).toBe(404);
    });

    it('should return 400 if league has teams', async () => {
      mockLeagueService.deleteLeague.mockRejectedValue(
        new BadRequestError('Cannot delete league with existing teams')
      );

      const response = await request(app).delete('/api/v1/leagues/league-1');

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
