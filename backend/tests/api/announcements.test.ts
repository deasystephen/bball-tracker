/**
 * Announcements API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { AnnouncementService } from '../../src/services/announcement-service';

const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-8901-2345-67890abcdef0';

// Mock auth middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../src/services/announcement-service');

const mockAnnouncementService = AnnouncementService as jest.Mocked<typeof AnnouncementService>;

describe('Announcements API', () => {
  const mockAnnouncement = {
    id: 'c3d4e5f6-a7b8-9012-3456-7890abcdef01',
    teamId: TEST_TEAM_ID,
    authorId: TEST_USER_ID,
    title: 'Practice moved',
    body: 'Practice is moved to 5pm tomorrow.',
    createdAt: new Date(),
    author: { id: TEST_USER_ID, name: 'Test User', email: 'test@example.com' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/teams/:teamId/announcements', () => {
    it('should create an announcement successfully', async () => {
      mockAnnouncementService.createAnnouncement.mockResolvedValue(mockAnnouncement as any);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
        .send({ title: 'Practice moved', body: 'Practice is moved to 5pm tomorrow.' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.announcement).toBeDefined();
      expect(mockAnnouncementService.createAnnouncement).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        { title: 'Practice moved', body: 'Practice is moved to 5pm tomorrow.' },
        TEST_USER_ID
      );
    });

    it('should return 400 for missing title', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
        .send({ body: 'Some body text' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing body', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
        .send({ title: 'Some title' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for empty title', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
        .send({ title: '', body: 'Some body' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid team ID format', async () => {
      const response = await request(app)
        .post('/api/v1/teams/not-a-uuid/announcements')
        .send({ title: 'Test', body: 'Test body' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/teams/:teamId/announcements', () => {
    it('should list announcements successfully', async () => {
      mockAnnouncementService.listAnnouncements.mockResolvedValue({
        announcements: [mockAnnouncement],
        total: 1,
        limit: 20,
        offset: 0,
      } as any);

      const response = await request(app)
        .get(`/api/v1/teams/${TEST_TEAM_ID}/announcements`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.announcements).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });

    it('should support pagination', async () => {
      mockAnnouncementService.listAnnouncements.mockResolvedValue({
        announcements: [],
        total: 0,
        limit: 5,
        offset: 10,
      } as any);

      const response = await request(app)
        .get(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
        .query({ limit: 5, offset: 10 });

      expect(response.status).toBe(200);
      expect(mockAnnouncementService.listAnnouncements).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        TEST_USER_ID,
        { limit: 5, offset: 10 }
      );
    });

    it('should return 400 for invalid team ID format', async () => {
      const response = await request(app)
        .get('/api/v1/teams/not-a-uuid/announcements');

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
