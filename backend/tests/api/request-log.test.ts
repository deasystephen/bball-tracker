/**
 * The per-request log line carries the authenticated user's id (#617), so a
 * user's requests can be followed in Datadog. Exercises the production
 * middleware order in `src/index.ts`: `requestLogger` is mounted before the
 * routers but logs on `finish`, after `authenticate` has run.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { logger } from '../../src/utils/logger';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    req.user = {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

jest.mock('../../src/services/team-service');
const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;

type RequestLine = { method: string; path: string; statusCode: number; duration: number; requestId?: string; userId?: string };

function requestLines(spy: jest.SpyInstance): RequestLine[] {
  return spy.mock.calls.filter(([msg]) => msg === 'HTTP request').map(([, ctx]) => ctx as RequestLine);
}

describe('request log', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    mockTeamService.listTeams.mockResolvedValue({ teams: [], total: 0, limit: 20, offset: 0 } as never);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('carries userId once the request authenticated', async () => {
    const res = await request(app).get('/api/v1/teams').set('Authorization', 'Bearer token');
    expect(res.status).toBe(200);

    const lines = requestLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(
      expect.objectContaining({ method: 'GET', path: '/api/v1/teams', statusCode: 200, userId: TEST_USER_ID })
    );
    expect(lines[0].requestId).toEqual(expect.any(String));
    expect(typeof lines[0].duration).toBe('number');
    // Ids only: the line never names the user.
    expect(JSON.stringify(lines[0])).not.toContain('test@example.com');
    expect(JSON.stringify(lines[0])).not.toContain('Test User');
  });

  it('has no userId when authentication did not run or was refused', async () => {
    const refused = await request(app).get('/api/v1/teams');
    expect(refused.status).toBe(401);
    const unknown = await request(app).get('/api/v1/no-such-route');
    expect(unknown.status).toBe(404);

    const lines = requestLines(infoSpy);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toHaveProperty('userId');
    }
    expect(lines.map((l) => l.statusCode)).toEqual([401, 404]);
  });

  it('echoes a client x-request-id and never logs /health', async () => {
    await request(app).get('/api/v1/teams').set('Authorization', 'Bearer token').set('x-request-id', 'trace-7');
    const [line] = requestLines(infoSpy);
    expect(line.requestId).toBe('trace-7');

    infoSpy.mockClear();
    await request(app).get('/health');
    expect(requestLines(infoSpy)).toHaveLength(0);
  });
});
