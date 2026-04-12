/**
 * Stats Export API Integration Tests
 */

import request from 'supertest';
import { Readable } from 'stream';
import { app, httpServer } from '../../src/index';
import { StatsExportService } from '../../src/services/stats-export-service';
import { NotFoundError, ForbiddenError } from '../../src/utils/errors';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEST_GAME_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';

// Mock the authenticate middleware
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
  requireRole: jest.fn(() => (_req: unknown, _res: unknown, next: () => void): void => next()),
}));

jest.mock('../../src/services/stats-export-service');

const mockExport = StatsExportService as jest.Mocked<typeof StatsExportService>;

afterAll((done) => {
  httpServer.close(() => done());
});

describe('Stats Export API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/games/:id/export.csv', () => {
    it('streams a CSV response with proper headers', async () => {
      const csv = 'event_id,game_id\nabc,xyz\n';
      mockExport.exportGameEventsCsv.mockResolvedValue({
        filename: 'lakers-2024-03-15-celtics-events.csv',
        stream: Readable.from([csv]),
        contentType: 'text/csv; charset=utf-8',
      });

      const res = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/export.csv`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        "attachment; filename=\"lakers-2024-03-15-celtics-events.csv\"; filename*=UTF-8''lakers-2024-03-15-celtics-events.csv"
      );
      expect(res.text).toBe(csv);
    });

    it('returns 404 when the game is not found', async () => {
      mockExport.exportGameEventsCsv.mockRejectedValue(new NotFoundError('Game not found'));

      const res = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/export.csv`);

      expect(res.status).toBe(404);
    });

    it('returns 403 when user lacks access', async () => {
      mockExport.exportGameEventsCsv.mockRejectedValue(
        new ForbiddenError('You do not have access to this game')
      );

      const res = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/export.csv`);

      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid UUID', async () => {
      const res = await request(app).get('/api/v1/games/not-a-uuid/export.csv');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/games/:id/boxscore.pdf', () => {
    it('streams a PDF response with proper headers', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4\n%fake pdf content');
      mockExport.exportGameBoxScorePdf.mockResolvedValue({
        filename: 'lakers-2024-03-15-celtics-boxscore.pdf',
        stream: Readable.from([pdfBytes]),
        contentType: 'application/pdf',
      });

      const res = await request(app)
        .get(`/api/v1/games/${TEST_GAME_ID}/boxscore.pdf`)
        .buffer(true)
        .parse((response, cb) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        "attachment; filename=\"lakers-2024-03-15-celtics-boxscore.pdf\"; filename*=UTF-8''lakers-2024-03-15-celtics-boxscore.pdf"
      );
      expect((res.body as Buffer).subarray(0, 4).toString('ascii')).toBe('%PDF');
    });

    it('returns 404 when the game is not found', async () => {
      mockExport.exportGameBoxScorePdf.mockRejectedValue(new NotFoundError('Game not found'));

      const res = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/boxscore.pdf`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/teams/:id/season-stats.csv', () => {
    it('streams a CSV response with proper headers', async () => {
      const csv = 'player_id,player_name\np-1,John Doe\n';
      mockExport.exportTeamSeasonStatsCsv.mockResolvedValue({
        filename: 'lakers-season-stats.csv',
        stream: Readable.from([csv]),
        contentType: 'text/csv; charset=utf-8',
      });

      const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/season-stats.csv`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        "attachment; filename=\"lakers-season-stats.csv\"; filename*=UTF-8''lakers-season-stats.csv"
      );
      expect(res.text).toBe(csv);
    });

    it('returns 403 when user lacks access to the team', async () => {
      mockExport.exportTeamSeasonStatsCsv.mockRejectedValue(
        new ForbiddenError('You do not have access to this team')
      );

      const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/season-stats.csv`);

      expect(res.status).toBe(403);
    });
  });
});
