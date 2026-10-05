/**
 * The request-context middleware opens the AsyncLocalStorage log context
 * (#617): a log line written by an async handler further down the chain
 * carries the request's id without the handler passing it.
 */

import express from 'express';
import request from 'supertest';
import { requestContext } from '../../src/api/middleware/request-context';
import { logger } from '../../src/utils/logger';
import { getLogContext, setLogContextUser } from '../../src/utils/log-context';
import { parseLogLines } from '../support/log-lines';

describe('requestContext middleware', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp(): express.Express {
    const app = express();
    app.use(requestContext);
    app.get('/thing', async (req, res) => {
      // Simulate a service call two awaits deep.
      await Promise.resolve();
      setLogContextUser('user-9');
      await new Promise((r) => setImmediate(r));
      res.json({ requestId: req.requestId, context: getLogContext() });
    });
    return app;
  }

  it('generates a request id and exposes it as the ambient context through async hops', async () => {
    const res = await request(buildApp()).get('/thing');
    expect(res.status).toBe(200);
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.context).toEqual({ requestId: res.body.requestId, userId: 'user-9' });
  });

  it('honours an incoming x-request-id header', async () => {
    const res = await request(buildApp()).get('/thing').set('x-request-id', 'client-abc');
    expect(res.body.requestId).toBe('client-abc');
    expect(res.body.context.requestId).toBe('client-abc');
  });

  it('a logger call inside the handler carries the request id with no explicit context', async () => {
    infoSpy.mockRestore();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const app = express();
    app.use(requestContext);
    app.get('/log', async (_req, res) => {
      await Promise.resolve();
      logger.info('Domain event', { teamId: 't1' });
      res.json({ ok: true });
    });

    await request(app).get('/log').set('x-request-id', 'req-42');

    const line = parseLogLines(logSpy).find((e) => e.message === 'Domain event');
    expect(line).toEqual(expect.objectContaining({ requestId: 'req-42', teamId: 't1' }));
  });
});
