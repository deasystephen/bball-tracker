/**
 * Calendar Feed API Integration Tests
 *
 * Covers:
 *   - POST /api/v1/teams/:id/calendar/subscribe
 *   - POST /api/v1/teams/:id/calendar/revoke
 *   - GET  /api/v1/teams/:id/calendar.ics?token=...
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { CalendarService } from '../../src/services/calendar-service';
import {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
} from '../../src/utils/errors';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../src/services/calendar-service');

const mockCalendarService = CalendarService as jest.Mocked<typeof CalendarService>;

describe('Calendar Feed API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/teams/:id/calendar/subscribe', () => {
    it('returns a feed URL for an authorized user', async () => {
      mockCalendarService.subscribe.mockResolvedValue({
        token: 'abc123',
        feedUrl: `http://localhost:3000/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=abc123`,
        webcalUrl: `webcal://localhost:3000/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=abc123`,
      });

      const res = await request(app).post(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar/subscribe`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBe('abc123');
      expect(res.body.feedUrl).toContain(`/teams/${TEST_TEAM_ID}/calendar.ics`);
      expect(res.body.webcalUrl.startsWith('webcal://')).toBe(true);
      expect(mockCalendarService.subscribe).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        TEST_USER_ID
      );
    });

    it('returns 403 when the user has no access to the team', async () => {
      mockCalendarService.subscribe.mockRejectedValue(
        new ForbiddenError('You do not have access to this team')
      );

      const res = await request(app).post(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar/subscribe`
      );
      expect(res.status).toBe(403);
    });

    it('returns 404 when the team does not exist', async () => {
      mockCalendarService.subscribe.mockRejectedValue(new NotFoundError('Team not found'));

      const res = await request(app).post(
        `/api/v1/teams/00000000-0000-0000-0000-000000000000/calendar/subscribe`
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 for an invalid team id (non-UUID)', async () => {
      const res = await request(app).post('/api/v1/teams/not-a-uuid/calendar/subscribe');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/teams/:id/calendar/revoke', () => {
    it('revokes the user\'s tokens for a team', async () => {
      mockCalendarService.revoke.mockResolvedValue({ revoked: 2 });

      const res = await request(app).post(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar/revoke`
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.revoked).toBe(2);
    });

    it('returns 404 for an unknown team', async () => {
      mockCalendarService.revoke.mockRejectedValue(new NotFoundError('Team not found'));
      const res = await request(app).post(
        `/api/v1/teams/00000000-0000-0000-0000-000000000000/calendar/revoke`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/teams/:id/calendar.ics', () => {
    it('returns a valid iCalendar body with text/calendar content type', async () => {
      mockCalendarService.resolveToken.mockResolvedValue({
        userId: TEST_USER_ID,
        teamId: TEST_TEAM_ID,
      });
      mockCalendarService.buildFeed.mockResolvedValue(
        'BEGIN:VCALENDAR\nEND:VCALENDAR'
      );

      const res = await request(app).get(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=goodtoken`
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/calendar/);
      expect(res.text).toContain('BEGIN:VCALENDAR');
      expect(mockCalendarService.resolveToken).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        'goodtoken'
      );
    });

    it('returns 400 when the token is missing', async () => {
      mockCalendarService.resolveToken.mockRejectedValue(
        new BadRequestError('Missing calendar token')
      );

      const res = await request(app).get(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar.ics`
      );
      expect(res.status).toBe(400);
    });

    it('returns 403 for a revoked token', async () => {
      mockCalendarService.resolveToken.mockRejectedValue(
        new ForbiddenError('Calendar token has been revoked')
      );

      const res = await request(app).get(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=revoked`
      );
      expect(res.status).toBe(403);
    });

    it('returns 403 when token belongs to a different team', async () => {
      mockCalendarService.resolveToken.mockRejectedValue(
        new ForbiddenError('Calendar token does not match team')
      );

      const res = await request(app).get(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=othertoken`
      );
      expect(res.status).toBe(403);
    });

    it('returns 403 when the user no longer has access to the team', async () => {
      mockCalendarService.resolveToken.mockRejectedValue(
        new ForbiddenError('User no longer has access to this team')
      );

      const res = await request(app).get(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=stale`
      );
      expect(res.status).toBe(403);
    });

    it('still returns an empty calendar when team has no games', async () => {
      mockCalendarService.resolveToken.mockResolvedValue({
        userId: TEST_USER_ID,
        teamId: TEST_TEAM_ID,
      });
      mockCalendarService.buildFeed.mockResolvedValue(
        'BEGIN:VCALENDAR\nEND:VCALENDAR'
      );

      const res = await request(app).get(
        `/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=good`
      );
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('BEGIN:VEVENT');
    });

    it('returns 400 for a non-UUID team id', async () => {
      const res = await request(app).get('/api/v1/teams/not-a-uuid/calendar.ics?token=x');
      expect(res.status).toBe(400);
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
