/**
 * body-parser error handling (audit #28): malformed JSON and oversized bodies
 * must answer 4xx, not 500, and must not be reported to Sentry.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { isExpectedClientError } from '../../src/utils/sentry';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

jest.mock('../../src/services/team-service');
jest.mock('../../src/services/usage-service', () => ({
  canCreateTeam: jest.fn().mockResolvedValue(true),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

// The "not reported to Sentry" half is proven in tests/utils/sentry.test.ts
// (`sentryErrorHandler` with a mocked @sentry/node); here we assert the
// classification the handler relies on plus the HTTP contract.
describe('body-parser errors', () => {
  afterAll(done => {
    httpServer.close(() => done());
  });

  it('POST /api/v1/teams with malformed JSON returns 400 and is not a Sentry-worthy error', async () => {
    const res = await request(app)
      .post('/api/v1/teams')
      .set('Content-Type', 'application/json')
      .send('{bad json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body' });
    expect(res.body.error).not.toContain('Unexpected');
  });

  it('POST /api/v1/teams with a body over 1 MB returns 413', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1024) });
    const res = await request(app)
      .post('/api/v1/teams')
      .set('Content-Type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large' });
  });

  it('classifies body-parser errors as expected client errors', () => {
    const parseFailed = Object.assign(new SyntaxError('Unexpected token b in JSON at position 1'), {
      status: 400,
      statusCode: 400,
      type: 'entity.parse.failed',
      expose: true,
    });
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      type: 'entity.too.large',
      expose: true,
    });
    expect(isExpectedClientError(parseFailed)).toBe(true);
    expect(isExpectedClientError(tooLarge)).toBe(true);
    // A plain 500-ish error is still reported.
    expect(isExpectedClientError(new Error('boom'))).toBe(false);
  });
});
