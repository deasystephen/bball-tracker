/**
 * Announcement detail + threaded replies API (#34): validation → route → service.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { AnnouncementService } from '../../src/services/announcement-service';
import { AnnouncementReplyService } from '../../src/services/announcement-reply-service';
import { ForbiddenError, NotFoundError } from '../../src/utils/errors';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const ANNOUNCEMENT_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const REPLY_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    req.user = { id: TEST_USER_ID, email: 'test@example.com', name: 'Test User', role: 'PLAYER' };
    next();
  }),
}));

jest.mock('../../src/services/announcement-service');
jest.mock('../../src/services/announcement-reply-service');

const mockAnnouncements = AnnouncementService as jest.Mocked<typeof AnnouncementService>;
const mockReplies = AnnouncementReplyService as jest.Mocked<typeof AnnouncementReplyService>;

const AUTH = { Authorization: 'Bearer token' };

const announcement = {
  id: ANNOUNCEMENT_ID,
  teamId: TEST_TEAM_ID,
  authorId: 'coach-1',
  title: 'Practice moved',
  body: 'Practice is moved to 5pm tomorrow.',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  author: { id: 'coach-1', name: 'Coach', email: 'coach@example.com' },
  _count: { replies: 1 },
};

const reply = {
  id: REPLY_ID,
  announcementId: ANNOUNCEMENT_ID,
  authorId: TEST_USER_ID,
  body: 'See you there',
  createdAt: new Date('2026-10-01T01:00:00Z'),
  author: { id: TEST_USER_ID, name: 'Test User', profilePictureUrl: null, deletedAt: null },
};

type Resolved<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

describe('Announcement replies API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll((done) => {
    // Never listened (supertest binds its own port); close only to release handles.
    httpServer.close(() => done());
  });

  describe('GET /api/v1/announcements/:id', () => {
    it('returns the announcement with its reply count', async () => {
      mockAnnouncements.getAnnouncement.mockResolvedValue(
        announcement as unknown as Resolved<typeof mockAnnouncements.getAnnouncement>
      );

      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`).set(AUTH);

      expect(response.status).toBe(200);
      expect(response.body.announcement).toMatchObject({ id: ANNOUNCEMENT_ID, _count: { replies: 1 } });
      expect(mockAnnouncements.getAnnouncement).toHaveBeenCalledWith(ANNOUNCEMENT_ID, TEST_USER_ID);
    });

    it('requires a session', async () => {
      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`);
      expect(response.status).toBe(401);
      expect(mockAnnouncements.getAnnouncement).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID id before reaching the service', async () => {
      const response = await request(app).get('/api/v1/announcements/not-a-uuid').set(AUTH);
      expect(response.status).toBe(400);
      expect(mockAnnouncements.getAnnouncement).not.toHaveBeenCalled();
    });

    it('maps NotFoundError to 404 and ForbiddenError to 403', async () => {
      mockAnnouncements.getAnnouncement.mockRejectedValueOnce(new NotFoundError('Announcement not found'));
      expect((await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`).set(AUTH)).status).toBe(404);

      mockAnnouncements.getAnnouncement.mockRejectedValueOnce(new ForbiddenError('You do not have access to this team'));
      expect((await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`).set(AUTH)).status).toBe(403);
    });

    it('answers 500 without leaking the error on an unexpected failure', async () => {
      mockAnnouncements.getAnnouncement.mockRejectedValueOnce(new Error('db down'));
      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`).set(AUTH);
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to load announcement');
    });
  });

  describe('POST /api/v1/announcements/:id/replies', () => {
    it('creates a reply and returns 201', async () => {
      mockReplies.createReply.mockResolvedValue(reply as unknown as Resolved<typeof mockReplies.createReply>);

      const response = await request(app)
        .post(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`)
        .set(AUTH)
        .send({ body: '  See you there  ' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.reply).toMatchObject({ id: REPLY_ID, body: 'See you there' });
      // Trimmed by the schema before the service sees it.
      expect(mockReplies.createReply).toHaveBeenCalledWith(ANNOUNCEMENT_ID, { body: 'See you there' }, TEST_USER_ID);
    });

    it('rejects an empty, whitespace-only or missing body', async () => {
      for (const payload of [{}, { body: '' }, { body: '   ' }]) {
        const response = await request(app)
          .post(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`)
          .set(AUTH)
          .send(payload);
        expect(response.status).toBe(400);
      }
      expect(mockReplies.createReply).not.toHaveBeenCalled();
    });

    it('rejects a body over 2000 characters', async () => {
      const response = await request(app)
        .post(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`)
        .set(AUTH)
        .send({ body: 'x'.repeat(2001) });
      expect(response.status).toBe(400);
    });

    it('rejects a non-UUID announcement id', async () => {
      const response = await request(app).post('/api/v1/announcements/nope/replies').set(AUTH).send({ body: 'Hi' });
      expect(response.status).toBe(400);
      expect(mockReplies.createReply).not.toHaveBeenCalled();
    });

    it('answers 403 when the caller has no access to the team', async () => {
      mockReplies.createReply.mockRejectedValueOnce(new ForbiddenError('You do not have access to this team'));
      const response = await request(app)
        .post(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`)
        .set(AUTH)
        .send({ body: 'Hi' });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('You do not have access to this team');
    });

    it('answers 404 for an unknown announcement', async () => {
      mockReplies.createReply.mockRejectedValueOnce(new NotFoundError('Announcement not found'));
      const response = await request(app)
        .post(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`)
        .set(AUTH)
        .send({ body: 'Hi' });
      expect(response.status).toBe(404);
    });

    it('answers 500 on an unexpected failure', async () => {
      mockReplies.createReply.mockRejectedValueOnce(new Error('boom'));
      const response = await request(app)
        .post(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`)
        .set(AUTH)
        .send({ body: 'Hi' });
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to create reply');
    });
  });

  describe('GET /api/v1/announcements/:id/replies', () => {
    it('lists the thread with pagination metadata, 20 per page by default', async () => {
      mockReplies.listReplies.mockResolvedValue({
        replies: [reply],
        total: 1,
        limit: 20,
        offset: 0,
      } as unknown as Resolved<typeof mockReplies.listReplies>);

      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`).set(AUTH);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, total: 1, limit: 20, offset: 0 });
      expect(response.body.replies).toHaveLength(1);
      expect(mockReplies.listReplies).toHaveBeenCalledWith(ANNOUNCEMENT_ID, TEST_USER_ID, { limit: 20, offset: 0 });
    });

    it('passes limit and offset through', async () => {
      mockReplies.listReplies.mockResolvedValue({
        replies: [],
        total: 0,
        limit: 5,
        offset: 40,
      } as unknown as Resolved<typeof mockReplies.listReplies>);

      const response = await request(app)
        .get(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies?limit=5&offset=40`)
        .set(AUTH);

      expect(response.status).toBe(200);
      expect(mockReplies.listReplies).toHaveBeenCalledWith(ANNOUNCEMENT_ID, TEST_USER_ID, { limit: 5, offset: 40 });
    });

    it('rejects an out-of-range limit', async () => {
      const response = await request(app)
        .get(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies?limit=101`)
        .set(AUTH);
      expect(response.status).toBe(400);
      expect(mockReplies.listReplies).not.toHaveBeenCalled();
    });

    it('answers 403 without team access and 404 for an unknown announcement', async () => {
      mockReplies.listReplies.mockRejectedValueOnce(new ForbiddenError('You do not have access to this team'));
      expect((await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`).set(AUTH)).status).toBe(403);

      mockReplies.listReplies.mockRejectedValueOnce(new NotFoundError('Announcement not found'));
      expect((await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`).set(AUTH)).status).toBe(404);
    });

    it('answers 500 on an unexpected failure', async () => {
      mockReplies.listReplies.mockRejectedValueOnce(new Error('boom'));
      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies`).set(AUTH);
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to list replies');
    });
  });

  describe('DELETE /api/v1/announcements/:id/replies/:replyId', () => {
    it('deletes and answers 204', async () => {
      mockReplies.deleteReply.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies/${REPLY_ID}`)
        .set(AUTH);

      expect(response.status).toBe(204);
      expect(mockReplies.deleteReply).toHaveBeenCalledWith(ANNOUNCEMENT_ID, REPLY_ID, TEST_USER_ID);
    });

    it('validates both ids', async () => {
      expect((await request(app).delete(`/api/v1/announcements/x/replies/${REPLY_ID}`).set(AUTH)).status).toBe(400);
      expect((await request(app).delete(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies/y`).set(AUTH)).status).toBe(400);
      expect(mockReplies.deleteReply).not.toHaveBeenCalled();
    });

    it('answers 403 when the caller is neither the author nor a coach', async () => {
      mockReplies.deleteReply.mockRejectedValueOnce(new ForbiddenError('You do not have permission to delete this reply'));
      const response = await request(app)
        .delete(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies/${REPLY_ID}`)
        .set(AUTH);
      expect(response.status).toBe(403);
    });

    it('answers 404 for an unknown reply', async () => {
      mockReplies.deleteReply.mockRejectedValueOnce(new NotFoundError('Reply not found'));
      const response = await request(app)
        .delete(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies/${REPLY_ID}`)
        .set(AUTH);
      expect(response.status).toBe(404);
    });

    it('answers 500 on an unexpected failure', async () => {
      mockReplies.deleteReply.mockRejectedValueOnce(new Error('boom'));
      const response = await request(app)
        .delete(`/api/v1/announcements/${ANNOUNCEMENT_ID}/replies/${REPLY_ID}`)
        .set(AUTH);
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to delete reply');
    });
  });
});
