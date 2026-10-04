/**
 * Unit tests for the /auth/refresh rate limiter (audit #21).
 *
 * Mounted on a bare Express app so the general per-IP API limiter in
 * src/index.ts doesn't interfere with the request counts.
 */

import express from 'express';
import request from 'supertest';
import type { Request } from 'express';
import {
  exportRateLimit,
  inviteRateLimit,
  inviteUserKey,
  refreshRateLimit,
  skipGlobalApiLimit,
} from '../../src/api/middleware/rate-limit';

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

/**
 * Bare apps for the per-user limiters: a header stands in for the
 * authenticated user that `router.use(authenticate)` attaches in production.
 */
function attachTestUser(app: express.Express): void {
  app.use((req, _res, next) => {
    const userId = req.header('x-test-user');
    if (userId) {
      req.user = {
        id: userId,
        email: null,
        name: 'Rate Limit Tester',
        role: 'COACH',
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      };
    }
    next();
  });
}

function buildExportApp(): express.Express {
  const app = express();
  attachTestUser(app);
  app.get('/games/:id/export.csv', exportRateLimit, (_req, res) => res.json({ ok: true }));
  app.get('/games/:id/boxscore.pdf', exportRateLimit, (_req, res) => res.json({ ok: true }));
  app.get('/teams/:id/season-stats.csv', exportRateLimit, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('exportRateLimit (issue #50)', () => {
  it('keys on the user, so 20 different users from one IP all pass', async () => {
    const app = buildExportApp();
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/games/g1/boxscore.pdf').set('x-test-user', `user-${i}`);
      expect(res.status).toBe(200);
    }
    const another = await request(app).get('/games/g1/boxscore.pdf').set('x-test-user', 'user-0');
    expect(another.status).toBe(200);
  });

  it('shares one 20/min budget across the three export routes and answers 429 on the 21st', async () => {
    const app = buildExportApp();
    const paths = ['/games/g1/export.csv', '/games/g1/boxscore.pdf', '/teams/t1/season-stats.csv'];
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get(paths[i % paths.length]).set('x-test-user', 'looper');
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get('/games/g1/boxscore.pdf').set('x-test-user', 'looper');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many export requests, please try again later' });
    expect(blocked.headers['ratelimit-limit'] ?? blocked.headers['ratelimit']).toBeDefined();

    // Throttling one account does not affect another on the same IP.
    const other = await request(app).get('/games/g1/boxscore.pdf').set('x-test-user', 'other-coach');
    expect(other.status).toBe(200);
  });

  it('falls back to the client IP when no user is attached', async () => {
    const app = buildExportApp();
    for (let i = 0; i < 20; i++) {
      await request(app).get('/games/g1/export.csv');
    }
    const blocked = await request(app).get('/games/g1/export.csv');
    expect(blocked.status).toBe(429);
  });
});

describe('inviteRateLimit (#715)', () => {
  function buildInviteApp(): express.Express {
    const app = express();
    attachTestUser(app);
    app.post('/teams/:teamId/invitations', inviteRateLimit, (_req, res) => res.status(201).json({ ok: true }));
    app.post('/teams/:teamId/players', inviteRateLimit, (_req, res) => res.status(201).json({ ok: true }));
    return app;
  }

  it('keys on the user id, with the IP as fallback', () => {
    expect(inviteUserKey({ user: { id: 'u-1' }, ip: '203.0.113.7' } as unknown as Request)).toBe('invite-user:u-1');
    expect(inviteUserKey({ ip: '203.0.113.7' } as unknown as Request)).toBe('ip:203.0.113.7');
  });

  it('shares one 60/hour budget across both routes and answers 429 on the 61st', async () => {
    const app = buildInviteApp();
    for (let i = 0; i < 60; i++) {
      const path = i % 2 === 0 ? '/teams/t1/invitations' : '/teams/t1/players';
      const res = await request(app).post(path).set('x-test-user', 'invite-looper');
      expect(res.status).toBe(201);
    }
    const blocked = await request(app).post('/teams/t1/invitations').set('x-test-user', 'invite-looper');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many invitations sent, please try again later' });
    expect(blocked.headers['ratelimit-remaining']).toBe('0');

    // Another coach on the same IP keeps their own budget.
    const other = await request(app).post('/teams/t1/invitations').set('x-test-user', 'another-coach');
    expect(other.status).toBe(201);
  });
});

describe('skipGlobalApiLimit (#718)', () => {
  const req = (method: string, path: string): Request => ({ method, path }) as unknown as Request;

  it('skips the public invitation lookup', () => {
    expect(skipGlobalApiLimit(req('GET', '/invitations/by-token/abcDEF_123-xyz'))).toBe(true);
  });

  it('does not skip the accept POST, other methods on the lookup, or any other route', () => {
    expect(skipGlobalApiLimit(req('POST', '/invitations/by-token/abc/accept'))).toBe(false);
    expect(skipGlobalApiLimit(req('GET', '/invitations/by-token/abc/accept'))).toBe(false);
    expect(skipGlobalApiLimit(req('POST', '/invitations/by-token/abc'))).toBe(false);
    expect(skipGlobalApiLimit(req('GET', '/teams'))).toBe(false);
    expect(skipGlobalApiLimit(req('GET', '/invitations'))).toBe(false);
    expect(skipGlobalApiLimit(req('GET', '/teams/invitations/by-token/abc'))).toBe(false);
  });
});
