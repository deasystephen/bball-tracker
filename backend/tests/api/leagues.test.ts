/**
 * Leagues API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { LeagueService } from '../../src/services/league-service';
import { NotFoundError, BadRequestError, ForbiddenError } from '../../src/utils/errors';

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

  describe('league admins (decision 3)', () => {
    const TARGET_USER_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';

    describe('POST /api/v1/leagues/:id/admins', () => {
      it('adds a league admin and returns 201', async () => {
        mockLeagueService.addLeagueAdmin.mockResolvedValue({
          id: 'la-1',
          leagueId: 'league-1',
          userId: TARGET_USER_ID,
          createdAt: new Date(),
          user: { id: TARGET_USER_ID, name: 'New Admin', email: 'admin@example.com' },
        } as unknown as Awaited<ReturnType<typeof mockLeagueService.addLeagueAdmin>>);

        const response = await request(app)
          .post('/api/v1/leagues/league-1/admins')
          .send({ userId: TARGET_USER_ID });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);
        expect(response.body.admin.user.id).toBe(TARGET_USER_ID);
        expect(mockLeagueService.addLeagueAdmin).toHaveBeenCalledWith('league-1', TARGET_USER_ID, 'test-user-id');
      });

      it('returns 400 when userId is missing or not a UUID', async () => {
        const missing = await request(app).post('/api/v1/leagues/league-1/admins').send({});
        expect(missing.status).toBe(400);

        const bad = await request(app).post('/api/v1/leagues/league-1/admins').send({ userId: 'not-a-uuid' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toContain('UUID');
        expect(mockLeagueService.addLeagueAdmin).not.toHaveBeenCalled();
      });

      it('returns 403 when the caller is not a system admin', async () => {
        mockLeagueService.addLeagueAdmin.mockRejectedValue(
          new ForbiddenError('Only system administrators can manage league admins')
        );

        const response = await request(app)
          .post('/api/v1/leagues/league-1/admins')
          .send({ userId: TARGET_USER_ID });

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Only system administrators can manage league admins');
      });

      it('returns 404 when the league or user does not exist', async () => {
        mockLeagueService.addLeagueAdmin.mockRejectedValue(new NotFoundError('League not found'));

        const response = await request(app)
          .post('/api/v1/leagues/missing/admins')
          .send({ userId: TARGET_USER_ID });

        expect(response.status).toBe(404);
      });

      it('returns 400 when the user is already an admin', async () => {
        mockLeagueService.addLeagueAdmin.mockRejectedValue(
          new BadRequestError('User is already an admin of this league')
        );

        const response = await request(app)
          .post('/api/v1/leagues/league-1/admins')
          .send({ userId: TARGET_USER_ID });

        expect(response.status).toBe(400);
      });

      it('returns 500 on unexpected errors', async () => {
        mockLeagueService.addLeagueAdmin.mockRejectedValue(new Error('boom'));

        const response = await request(app)
          .post('/api/v1/leagues/league-1/admins')
          .send({ userId: TARGET_USER_ID });

        expect(response.status).toBe(500);
        expect(response.body.error).toBe('Failed to add league admin');
      });
    });

    describe('DELETE /api/v1/leagues/:id/admins/:userId', () => {
      it('removes a league admin', async () => {
        mockLeagueService.removeLeagueAdmin.mockResolvedValue({ success: true });

        const response = await request(app).delete(`/api/v1/leagues/league-1/admins/${TARGET_USER_ID}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(mockLeagueService.removeLeagueAdmin).toHaveBeenCalledWith('league-1', TARGET_USER_ID, 'test-user-id');
      });

      it('returns 400 for a non-UUID userId param', async () => {
        const response = await request(app).delete('/api/v1/leagues/league-1/admins/not-a-uuid');

        expect(response.status).toBe(400);
        expect(mockLeagueService.removeLeagueAdmin).not.toHaveBeenCalled();
      });

      it('returns 403 when the caller is not a system admin', async () => {
        mockLeagueService.removeLeagueAdmin.mockRejectedValue(
          new ForbiddenError('Only system administrators can remove league admins')
        );

        const response = await request(app).delete(`/api/v1/leagues/league-1/admins/${TARGET_USER_ID}`);

        expect(response.status).toBe(403);
      });

      it('returns 404 when the user is not an admin of the league', async () => {
        mockLeagueService.removeLeagueAdmin.mockRejectedValue(new NotFoundError('League admin not found'));

        const response = await request(app).delete(`/api/v1/leagues/league-1/admins/${TARGET_USER_ID}`);

        expect(response.status).toBe(404);
      });

      it('returns 500 on unexpected errors', async () => {
        mockLeagueService.removeLeagueAdmin.mockRejectedValue(new Error('boom'));

        const response = await request(app).delete(`/api/v1/leagues/league-1/admins/${TARGET_USER_ID}`);

        expect(response.status).toBe(500);
        expect(response.body.error).toBe('Failed to remove league admin');
      });
    });
  });

  describe('POST /api/v1/leagues', () => {
    it('should create a league successfully', async () => {
      mockLeagueService.createLeague.mockResolvedValue(mockLeague as unknown as Awaited<ReturnType<typeof mockLeagueService.createLeague>>);

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

    it('should return 403 when the caller is not a system admin', async () => {
      mockLeagueService.createLeague.mockRejectedValue(
        new ForbiddenError('Only system administrators can create leagues')
      );

      const response = await request(app)
        .post('/api/v1/leagues')
        .send({ name: 'Spring League' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Only system administrators can create leagues');
    });
  });

  describe('GET /api/v1/leagues', () => {
    it('should list leagues successfully', async () => {
      mockLeagueService.listLeagues.mockResolvedValue({
        leagues: [mockLeague],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockLeagueService.listLeagues>>);

      const response = await request(app).get('/api/v1/leagues');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.leagues).toHaveLength(1);
    });

    it('should filter leagues by search term', async () => {
      mockLeagueService.listLeagues.mockResolvedValue({
        leagues: [mockLeague],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockLeagueService.listLeagues>>);

      const response = await request(app)
        .get('/api/v1/leagues')
        .query({ search: 'Spring' });

      expect(response.status).toBe(200);
      // #443: the route now passes the authenticated caller so the service can
      // scope the list.
      expect(mockLeagueService.listLeagues).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Spring' }),
        { id: 'test-user-id', role: 'COACH' }
      );
    });

    it('should support pagination', async () => {
      mockLeagueService.listLeagues.mockResolvedValue({
        leagues: [mockLeague],
        pagination: { total: 25, limit: 10, offset: 10, hasMore: true },
      } as unknown as Awaited<ReturnType<typeof mockLeagueService.listLeagues>>);

      const response = await request(app)
        .get('/api/v1/leagues')
        .query({ limit: 10, offset: 10 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /api/v1/leagues/:id', () => {
    it('should get a league by ID', async () => {
      mockLeagueService.getLeagueById.mockResolvedValue(mockLeague as unknown as Awaited<ReturnType<typeof mockLeagueService.getLeagueById>>);

      const response = await request(app).get('/api/v1/leagues/league-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.league.id).toBe('league-1');
      // The caller's id is forwarded so the service can scope the payload (audit #4)
      expect(mockLeagueService.getLeagueById).toHaveBeenCalledWith('league-1', 'test-user-id');
    });

    it('should return the stripped payload (no admins/staff/members) for an unaffiliated user', async () => {
      mockLeagueService.getLeagueById.mockResolvedValue({
        id: 'league-1',
        name: 'Spring League',
        createdAt: new Date(),
        updatedAt: new Date(),
        seasons: [{ id: 'season-1', name: 'Spring', teams: [{ id: 'team-1', name: 'Hawks' }] }],
      } as unknown as Awaited<ReturnType<typeof mockLeagueService.getLeagueById>>);

      const response = await request(app).get('/api/v1/leagues/league-1');

      expect(response.status).toBe(200);
      expect(response.body.league.admins).toBeUndefined();
      expect(response.body.league.seasons[0].teams[0]).toEqual({ id: 'team-1', name: 'Hawks' });
      expect(JSON.stringify(response.body)).not.toContain('email');
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
      mockLeagueService.updateLeague.mockResolvedValue(updatedLeague as unknown as Awaited<ReturnType<typeof mockLeagueService.updateLeague>>);

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

    it('should return 403 (not 400) when the caller is not a league admin', async () => {
      mockLeagueService.updateLeague.mockRejectedValue(
        new ForbiddenError('You do not have permission to update this league')
      );

      const response = await request(app)
        .patch('/api/v1/leagues/league-1')
        .send({ name: 'New Name' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('You do not have permission to update this league');
    });

    it('should return 400 when the new name is already taken', async () => {
      mockLeagueService.updateLeague.mockRejectedValue(
        new BadRequestError('League with this name already exists')
      );

      const response = await request(app)
        .patch('/api/v1/leagues/league-1')
        .send({ name: 'Taken' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('League with this name already exists');
    });
  });

  describe('DELETE /api/v1/leagues/:id', () => {
    it('should delete a league successfully', async () => {
      mockLeagueService.deleteLeague.mockResolvedValue({ success: true });

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

    it('should return 403 when the caller is not a system admin', async () => {
      mockLeagueService.deleteLeague.mockRejectedValue(
        new ForbiddenError('Only system administrators can delete leagues')
      );

      const response = await request(app).delete('/api/v1/leagues/league-1');

      expect(response.status).toBe(403);
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
