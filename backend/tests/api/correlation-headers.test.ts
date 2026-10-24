/**
 * The correlation headers of #963 through the production middleware chain
 * (`src/index.ts`: `requestContext`, `requestLogger`, the routers):
 *
 * - `X-Request-Id`: a UUID from the client becomes the request's `requestId`;
 *   anything else is replaced by a generated UUID and never logged. The id
 *   used is echoed on every response.
 * - `X-Hooplings-Client`: a valid value is logged as `client` on the
 *   `HTTP request` line and on every line written inside the request; an
 *   invalid value is dropped and never logged.
 *
 * The lines are read from `console.log`, after the logger merged the request
 * context, so what is asserted is what Datadog receives.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { logger } from '../../src/utils/logger';
import { parseLogLines, type LogLine } from '../support/log-lines';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const CLIENT_REQUEST_ID = 'c0ffee00-1234-4abc-8def-0123456789ab';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN_EVENT = 'Domain event inside the request';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
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

function requestLine(spy: jest.SpyInstance): LogLine {
  const lines = parseLogLines(spy).filter((line) => line.message === 'HTTP request');
  expect(lines).toHaveLength(1);
  return lines[0];
}

function domainLine(spy: jest.SpyInstance): LogLine {
  const lines = parseLogLines(spy).filter((line) => line.message === DOMAIN_EVENT);
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe('correlation headers (#963)', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockTeamService.listTeams.mockImplementation(async (query) => {
      logger.info(DOMAIN_EVENT, { teamId: 'team-1' });
      return { teams: [], total: 0, limit: query.limit, offset: query.offset };
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('X-Request-Id', () => {
    it('uses a valid client UUID as the requestId and echoes it', async () => {
      const res = await request(app).get('/api/v1/teams').set('X-Request-Id', CLIENT_REQUEST_ID);

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(CLIENT_REQUEST_ID);
      expect(requestLine(consoleSpy).requestId).toBe(CLIENT_REQUEST_ID);
      expect(domainLine(consoleSpy).requestId).toBe(CLIENT_REQUEST_ID);
    });

    it('replaces an invalid id with a generated UUID, echoes that and never logs the client value', async () => {
      const res = await request(app).get('/api/v1/teams').set('X-Request-Id', 'trace-7 injected');

      const line = requestLine(consoleSpy);
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(line.requestId).toBe(res.headers['x-request-id']);
      expect(consoleSpy.mock.calls.map(([l]) => String(l)).join('\n')).not.toContain('trace-7');
    });

    it('generates and echoes an id when the header is absent', async () => {
      const res = await request(app).get('/api/v1/teams');

      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(requestLine(consoleSpy).requestId).toBe(res.headers['x-request-id']);
    });

    it('echoes the id on an error response and on /health', async () => {
      const notFound = await request(app).get('/api/v1/no-such-route').set('X-Request-Id', CLIENT_REQUEST_ID);
      expect(notFound.status).toBe(404);
      expect(notFound.headers['x-request-id']).toBe(CLIENT_REQUEST_ID);

      const health = await request(app).get('/health');
      expect(health.headers['x-request-id']).toMatch(UUID);
    });

    it('echoes the id and logs the request when the body parser refuses the body (400)', async () => {
      // requestContext and requestLogger run before express.json (#963 review).
      const res = await request(app)
        .post('/api/v1/teams')
        .set('Content-Type', 'application/json')
        .set('X-Request-Id', CLIENT_REQUEST_ID)
        .set('X-Hooplings-Client', 'web')
        .send('{bad json');

      expect(res.status).toBe(400);
      expect(res.headers['x-request-id']).toBe(CLIENT_REQUEST_ID);
      expect(requestLine(consoleSpy)).toEqual(
        expect.objectContaining({ method: 'POST', statusCode: 400, requestId: CLIENT_REQUEST_ID, client: 'web' })
      );
    });

    it('gives two requests without the header two different ids', async () => {
      const first = await request(app).get('/api/v1/teams');
      const second = await request(app).get('/api/v1/teams');
      expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    });
  });

  describe('X-Hooplings-Client', () => {
    it.each(['web', 'ios/1.6.0+01a15220-8b6d-7172-a9a5-2d5fce7c6954'])(
      'logs a valid value (%s) as client on the request line and on lines inside the request',
      async (client) => {
        const res = await request(app).get('/api/v1/teams').set('X-Hooplings-Client', client);

        expect(res.status).toBe(200);
        expect(requestLine(consoleSpy)).toEqual(
          expect.objectContaining({ method: 'GET', path: '/api/v1/teams', client, userId: TEST_USER_ID })
        );
        expect(domainLine(consoleSpy).client).toBe(client);
      }
    );

    it('drops an invalid value: no client field, the value appears nowhere, the request is served', async () => {
      const res = await request(app)
        .get('/api/v1/teams')
        .set('X-Hooplings-Client', 'ios/1.6.0+someone@example.com');

      expect(res.status).toBe(200);
      expect(requestLine(consoleSpy)).not.toHaveProperty('client');
      expect(domainLine(consoleSpy)).not.toHaveProperty('client');
      expect(consoleSpy.mock.calls.map(([l]) => String(l)).join('\n')).not.toContain('someone@example.com');
    });

    it('drops an oversized value', async () => {
      await request(app).get('/api/v1/teams').set('X-Hooplings-Client', `ios/1.6.0+${'a'.repeat(80)}`);
      expect(requestLine(consoleSpy)).not.toHaveProperty('client');
    });

    it('has no client field when the header is absent', async () => {
      await request(app).get('/api/v1/teams');
      expect(requestLine(consoleSpy)).not.toHaveProperty('client');
      expect(domainLine(consoleSpy)).not.toHaveProperty('client');
    });

    it('does not leak one request\'s client into the next', async () => {
      await request(app).get('/api/v1/teams').set('X-Hooplings-Client', 'web');
      consoleSpy.mockClear();
      await request(app).get('/api/v1/teams');
      expect(requestLine(consoleSpy)).not.toHaveProperty('client');
    });
  });
});
