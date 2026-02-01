/**
 * Seasons API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { SeasonService } from '../../src/services/season-service';
import { NotFoundError, BadRequestError } from '../../src/utils/errors';

// Test IDs - mix of UUIDs and custom strings to test both formats
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_SEASON_ID = 'f6a7b8c9-d0e1-2345-6789-0abcdef01234';
const TEST_LEAGUE_ID_UUID = 'c3d4e5f6-a7b8-9012-3456-7890abcdef01';
const TEST_LEAGUE_ID_CUSTOM = 'downtown-youth-league'; // Custom string ID like in seed

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'ADMIN',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the service
jest.mock('../../src/services/season-service');

const mockSeasonService = SeasonService as jest.Mocked<typeof SeasonService>;

describe('Seasons API', () => {
  const mockSeason = {
    id: TEST_SEASON_ID,
    leagueId: TEST_LEAGUE_ID_UUID,
    name: 'Spring 2024',
    startDate: new Date('2024-03-01'),
    endDate: new Date('2024-06-30'),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    league: {
      id: TEST_LEAGUE_ID_UUID,
      name: 'Downtown Youth Basketball League',
    },
  };

  const mockSeasonWithCustomLeagueId = {
    ...mockSeason,
    leagueId: TEST_LEAGUE_ID_CUSTOM,
    league: {
      id: TEST_LEAGUE_ID_CUSTOM,
      name: 'Downtown Youth Basketball League',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/seasons', () => {
    it('should create a season with UUID league ID', async () => {
      mockSeasonService.createSeason.mockResolvedValue(mockSeason as any);

      const response = await request(app)
        .post('/api/v1/seasons')
        .send({
          leagueId: TEST_LEAGUE_ID_UUID,
          name: 'Spring 2024',
          startDate: '2024-03-01',
          endDate: '2024-06-30',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.season).toBeDefined();
      expect(mockSeasonService.createSeason).toHaveBeenCalledWith(
        expect.objectContaining({
          leagueId: TEST_LEAGUE_ID_UUID,
          name: 'Spring 2024',
        }),
        TEST_USER_ID
      );
    });

    it('should create a season with custom string league ID', async () => {
      mockSeasonService.createSeason.mockResolvedValue(mockSeasonWithCustomLeagueId as any);

      const response = await request(app)
        .post('/api/v1/seasons')
        .send({
          leagueId: TEST_LEAGUE_ID_CUSTOM,
          name: 'Spring 2024',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(mockSeasonService.createSeason).toHaveBeenCalledWith(
        expect.objectContaining({
          leagueId: TEST_LEAGUE_ID_CUSTOM,
          name: 'Spring 2024',
        }),
        TEST_USER_ID
      );
    });

    it('should return 400 for missing league ID', async () => {
      const response = await request(app)
        .post('/api/v1/seasons')
        .send({ name: 'Spring 2024' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for empty league ID', async () => {
      const response = await request(app)
        .post('/api/v1/seasons')
        .send({ leagueId: '', name: 'Spring 2024' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('League ID is required');
    });

    it('should return 400 for missing season name', async () => {
      const response = await request(app)
        .post('/api/v1/seasons')
        .send({ leagueId: TEST_LEAGUE_ID_UUID });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for empty season name', async () => {
      const response = await request(app)
        .post('/api/v1/seasons')
        .send({ leagueId: TEST_LEAGUE_ID_UUID, name: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Season name is required');
    });

    it('should return 400 for season name too long', async () => {
      const response = await request(app)
        .post('/api/v1/seasons')
        .send({
          leagueId: TEST_LEAGUE_ID_UUID,
          name: 'A'.repeat(101),
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Season name too long');
    });

    it('should handle NotFoundError from service', async () => {
      mockSeasonService.createSeason.mockRejectedValue(
        new NotFoundError('League not found')
      );

      const response = await request(app)
        .post('/api/v1/seasons')
        .send({
          leagueId: TEST_LEAGUE_ID_UUID,
          name: 'Spring 2024',
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('League not found');
    });

    it('should handle BadRequestError from service', async () => {
      mockSeasonService.createSeason.mockRejectedValue(
        new BadRequestError('Season with this name already exists')
      );

      const response = await request(app)
        .post('/api/v1/seasons')
        .send({
          leagueId: TEST_LEAGUE_ID_UUID,
          name: 'Spring 2024',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Season with this name already exists');
    });
  });

  describe('GET /api/v1/seasons', () => {
    it('should list seasons successfully', async () => {
      mockSeasonService.listSeasons.mockResolvedValue({
        seasons: [mockSeason],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/seasons');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.seasons).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should filter by UUID league ID', async () => {
      mockSeasonService.listSeasons.mockResolvedValue({
        seasons: [mockSeason],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/seasons')
        .query({ leagueId: TEST_LEAGUE_ID_UUID });

      expect(response.status).toBe(200);
      expect(mockSeasonService.listSeasons).toHaveBeenCalledWith(
        expect.objectContaining({ leagueId: TEST_LEAGUE_ID_UUID })
      );
    });

    it('should filter by custom string league ID', async () => {
      mockSeasonService.listSeasons.mockResolvedValue({
        seasons: [mockSeasonWithCustomLeagueId],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/seasons')
        .query({ leagueId: TEST_LEAGUE_ID_CUSTOM });

      expect(response.status).toBe(200);
      expect(mockSeasonService.listSeasons).toHaveBeenCalledWith(
        expect.objectContaining({ leagueId: TEST_LEAGUE_ID_CUSTOM })
      );
    });

    it('should filter by isActive', async () => {
      mockSeasonService.listSeasons.mockResolvedValue({
        seasons: [mockSeason],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/seasons')
        .query({ isActive: 'true' });

      expect(response.status).toBe(200);
      expect(mockSeasonService.listSeasons).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true })
      );
    });

    it('should handle pagination parameters', async () => {
      mockSeasonService.listSeasons.mockResolvedValue({
        seasons: [],
        pagination: { total: 50, limit: 10, offset: 20, hasMore: true },
      } as any);

      const response = await request(app)
        .get('/api/v1/seasons')
        .query({ limit: '10', offset: '20' });

      expect(response.status).toBe(200);
      expect(mockSeasonService.listSeasons).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 })
      );
    });
  });

  describe('GET /api/v1/seasons/:id', () => {
    it('should get a season by ID', async () => {
      mockSeasonService.getSeasonById.mockResolvedValue(mockSeason as any);

      const response = await request(app).get(`/api/v1/seasons/${TEST_SEASON_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.season.id).toBe(TEST_SEASON_ID);
    });

    it('should return 404 for non-existent season', async () => {
      mockSeasonService.getSeasonById.mockRejectedValue(
        new NotFoundError('Season not found')
      );

      const response = await request(app).get('/api/v1/seasons/non-existent');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Season not found');
    });
  });

  describe('PATCH /api/v1/seasons/:id', () => {
    it('should update a season successfully', async () => {
      const updatedSeason = { ...mockSeason, name: 'Fall 2024' };
      mockSeasonService.updateSeason.mockResolvedValue(updatedSeason as any);

      const response = await request(app)
        .patch(`/api/v1/seasons/${TEST_SEASON_ID}`)
        .send({ name: 'Fall 2024' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.season.name).toBe('Fall 2024');
    });

    it('should update isActive status', async () => {
      const updatedSeason = { ...mockSeason, isActive: false };
      mockSeasonService.updateSeason.mockResolvedValue(updatedSeason as any);

      const response = await request(app)
        .patch(`/api/v1/seasons/${TEST_SEASON_ID}`)
        .send({ isActive: false });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 for empty name', async () => {
      const response = await request(app)
        .patch(`/api/v1/seasons/${TEST_SEASON_ID}`)
        .send({ name: '' });

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent season', async () => {
      mockSeasonService.updateSeason.mockRejectedValue(
        new NotFoundError('Season not found')
      );

      const response = await request(app)
        .patch('/api/v1/seasons/non-existent')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });

    it('should return 400 for unauthorized update', async () => {
      mockSeasonService.updateSeason.mockRejectedValue(
        new BadRequestError('Not authorized to update this season')
      );

      const response = await request(app)
        .patch(`/api/v1/seasons/${TEST_SEASON_ID}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/seasons/:id', () => {
    it('should delete a season successfully', async () => {
      mockSeasonService.deleteSeason.mockResolvedValue(undefined as any);

      const response = await request(app).delete(`/api/v1/seasons/${TEST_SEASON_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Season deleted successfully');
    });

    it('should return 404 for non-existent season', async () => {
      mockSeasonService.deleteSeason.mockRejectedValue(
        new NotFoundError('Season not found')
      );

      const response = await request(app).delete('/api/v1/seasons/non-existent');

      expect(response.status).toBe(404);
    });

    it('should return 400 for unauthorized delete', async () => {
      mockSeasonService.deleteSeason.mockRejectedValue(
        new BadRequestError('Not authorized to delete this season')
      );

      const response = await request(app).delete(`/api/v1/seasons/${TEST_SEASON_ID}`);

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
