/**
 * The request-context middleware opens the AsyncLocalStorage log context
 * (#617): a log line written by an async handler further down the chain
 * carries the request's id without the handler passing it.
 */

import express from 'express';
import request from 'supertest';
import { requestContext } from '../../src/api/middleware/request-context';
import { logger } from '../../src/utils/logger';
import { spyOnInfo } from '../support/domain-events';
import { getLogContext, setLogContextUser } from '../../src/utils/log-context';
import { parseLogLines } from '../support/log-lines';

const CLIENT_ID = 'c0ffee00-1234-4abc-8def-0123456789ab';

describe('requestContext middleware', () => {
  let infoSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = spyOnInfo();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleSpy.mockRestore();
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

  it('honours an incoming x-request-id header that is a UUID, and echoes it (#963)', async () => {
    const res = await request(buildApp()).get('/thing').set('x-request-id', CLIENT_ID);
    expect(res.body.requestId).toBe(CLIENT_ID);
    expect(res.body.context.requestId).toBe(CLIENT_ID);
    expect(res.headers['x-request-id']).toBe(CLIENT_ID);
  });

  it('replaces an x-request-id that is not a UUID with a generated one (#963)', async () => {
    const res = await request(buildApp()).get('/thing').set('x-request-id', 'client-abc');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.requestId).not.toBe('client-abc');
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('adds a valid X-Hooplings-Client to the context and drops an invalid one (#963)', async () => {
    const valid = await request(buildApp()).get('/thing').set('x-hooplings-client', 'ios/1.6.0+embedded');
    expect(valid.body.context).toEqual({ requestId: valid.body.requestId, userId: 'user-9', client: 'ios/1.6.0+embedded' });

    const invalid = await request(buildApp()).get('/thing').set('x-hooplings-client', 'curl/8.0');
    expect(invalid.body.context).toEqual({ requestId: invalid.body.requestId, userId: 'user-9' });
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

    await request(app).get('/log').set('x-request-id', CLIENT_ID);

    const line = parseLogLines(logSpy).find((e) => e.message === 'Domain event');
    expect(line).toEqual(expect.objectContaining({ requestId: CLIENT_ID, teamId: 't1' }));
  });
});
