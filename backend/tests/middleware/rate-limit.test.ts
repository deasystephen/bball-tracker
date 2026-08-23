/**
 * Unit tests for the /auth/refresh rate limiter (audit #21).
 *
 * Mounted on a bare Express app so the general per-IP API limiter in
 * src/index.ts doesn't interfere with the request counts.
 */

import express from 'express';
import request from 'supertest';
import { refreshRateLimit } from '../../src/api/middleware/rate-limit';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.post('/refresh', refreshRateLimit, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('refreshRateLimit', () => {
  it('keys on the refresh token, so 60 distinct tokens from one IP all pass', async () => {
    const app = buildApp();
    for (let i = 0; i < 60; i++) {
      const res = await request(app).post('/refresh').send({ refreshToken: `token-${i}` });
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when one token is replayed more than 60 times in the window', async () => {
    const app = buildApp();
    for (let i = 0; i < 60; i++) {
      const res = await request(app).post('/refresh').send({ refreshToken: 'replayed' });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).post('/refresh').send({ refreshToken: 'replayed' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many refresh attempts, please try again later' });
    expect(blocked.headers['ratelimit-limit'] ?? blocked.headers['ratelimit']).toBeDefined();

    // Throttling one token does not affect another device's token.
    const other = await request(app).post('/refresh').send({ refreshToken: 'other-device' });
    expect(other.status).toBe(200);
  });

  it('falls back to the client IP when the body carries no token', async () => {
    const app = buildApp();
    for (let i = 0; i < 60; i++) {
      await request(app).post('/refresh').send({});
    }
    const blocked = await request(app).post('/refresh').send({ refreshToken: 123 });
    expect(blocked.status).toBe(429);
  });
});
