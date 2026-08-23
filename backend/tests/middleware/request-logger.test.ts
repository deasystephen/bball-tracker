/**
 * Request logger redaction (audit #15): query values and secret path segments
 * must never reach the structured log.
 */

import express from 'express';
import request from 'supertest';
import { loggablePath, requestLogger } from '../../src/api/middleware/request-logger';
import { logger } from '../../src/utils/logger';

describe('loggablePath', () => {
  it('keeps query keys and masks sensitive values', () => {
    expect(
      loggablePath({ path: '/callback', originalUrl: '/api/v1/auth/callback?code=abc123&state=st&x=1' })
    ).toBe('/api/v1/auth/callback?code=[redacted]&state=[redacted]&x=1');
  });

  it('masks by-token and calendar path segments', () => {
    expect(
      loggablePath({
        path: '/by-token/abcdef0123456789',
        originalUrl: '/api/v1/invitations/by-token/abcdef0123456789',
      })
    ).toBe('/api/v1/invitations/by-token/[redacted]');
    expect(
      loggablePath({
        path: '/t1/calendar/abcdef0123456789',
        originalUrl: '/api/v1/teams/t1/calendar/abcdef0123456789',
      })
    ).toBe('/api/v1/teams/t1/calendar/[redacted]');
    expect(
      loggablePath({ path: '/t1/calendar.ics', originalUrl: '/api/v1/teams/t1/calendar.ics?token=tok123' })
    ).toBe('/api/v1/teams/t1/calendar.ics?token=[redacted]');
  });

  it('falls back to req.path when originalUrl is empty', () => {
    expect(loggablePath({ path: '/x', originalUrl: '' })).toBe('/x');
  });
});

describe('requestLogger middleware', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  function buildApp(): express.Express {
    const app = express();
    app.use(requestLogger);
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/auth/callback', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/invitations/by-token/:token', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('logs a redacted query string, never the raw OAuth code', async () => {
    await request(buildApp()).get('/api/v1/auth/callback?code=SECRETCODE&state=SECRETSTATE');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const ctx = infoSpy.mock.calls[0][1] as { path: string; method: string; statusCode: number };
    expect(ctx.path).toBe('/api/v1/auth/callback?code=[redacted]&state=[redacted]');
    expect(ctx.method).toBe('GET');
    expect(ctx.statusCode).toBe(200);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('SECRET');
  });

  it('masks the by-token path segment', async () => {
    await request(buildApp()).get('/api/v1/invitations/by-token/abcdef0123456789');
    const ctx = infoSpy.mock.calls[0][1] as { path: string };
    expect(ctx.path).toBe('/api/v1/invitations/by-token/[redacted]');
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('abcdef0123456789');
  });

  it('skips /health', async () => {
    await request(buildApp()).get('/health');
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
