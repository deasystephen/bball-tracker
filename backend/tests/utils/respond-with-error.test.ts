import type { Request, Response } from 'express';
import { respondWithError } from '../../src/utils/respond-with-error';
import {
  AppError,
  ConflictError,
  LastHeadCoachError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { captureRequestException } from '../../src/utils/sentry';

jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureRequestException: jest.fn(),
}));
const mockCapture = captureRequestException as jest.MockedFunction<typeof captureRequestException>;

const REQ = { method: 'GET', originalUrl: '/api/v1/x' } as Request;

/** A Response double that records what was sent, like Express does. */
function fakeRes(headersSent = false): Response & { body?: unknown; ended: boolean } {
  const res = {
    req: REQ,
    statusCode: 200,
    headersSent,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.headersSent = true;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res as unknown as Response & { body?: unknown; ended: boolean };
}

describe('respondWithError (#831)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it.each([
    [new NotFoundError('Team not found'), 404],
    [new ConflictError('Already exists'), 409],
    [new AppError('Teapot', 418), 418],
  ])('answers %p with its own status and message, logged at warn', (err, status) => {
    const res = fakeRes();
    respondWithError(res, err, { log: 'Error doing X', fallback: 'Failed to do X', sentryFlow: 'x' });
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: err.message });
    expect(warn).toHaveBeenCalledWith('Error doing X', { status, error: err.message });
    expect(error).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('answers a DetailedError with its body()', () => {
    const res = fakeRes();
    const err = new LastHeadCoachError([{ id: 't1', name: 'Hawks' }]);
    respondWithError(res, err, { log: 'Error deleting account', fallback: 'Failed' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(err.body());
    expect(res.body).toMatchObject({ code: 'last_head_coach', teams: [{ id: 't1', name: 'Hawks' }] });
  });

  it('answers anything else with the fallback body at 500, logs at error, reports the flow with the request', () => {
    const res = fakeRes();
    const err = new Error('connection reset');
    respondWithError(res, err, { log: 'Error doing X', fallback: 'Failed to do X', sentryFlow: 'x-flow' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to do X' });
    expect(error).toHaveBeenCalledWith('Error doing X', { status: 500, error: 'connection reset' });
    expect(mockCapture).toHaveBeenCalledWith(err, REQ, { flow: 'x-flow' });
  });

  it('never reports to Sentry without a flow', () => {
    respondWithError(fakeRes(), new Error('boom'), { log: 'Error', fallback: 'Failed' });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('accepts a fallback body with extra fields', () => {
    const res = fakeRes();
    respondWithError(res, 'boom', { log: 'Error', fallback: { error: 'Failed', details: 'boom' } });
    expect(res.body).toEqual({ error: 'Failed', details: 'boom' });
  });

  it('keeps the status of a 5xx AppError but answers the fallback body, never its internal message', () => {
    const res = fakeRes();
    const err = new ServiceUnavailableError('Database unavailable');
    respondWithError(res, err, { log: 'Error', fallback: 'Failed to do X', sentryFlow: 'auth-me' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Failed to do X' });
    expect(error).toHaveBeenCalledWith('Error', { status: 503, error: 'Database unavailable' });
    expect(mockCapture).toHaveBeenCalledWith(err, REQ, { flow: 'auth-me' });
  });

  it.each([
    ['status', 429],
    ['statusCode', 400],
  ])('honours a 4xx %s on a non-AppError (the central handler rule) with the fallback body', (key, status) => {
    const res = fakeRes();
    const err = Object.assign(new Error('Rate limit exceeded'), { [key]: status });
    respondWithError(res, err, { log: 'Error', fallback: 'Authentication failed', sentryFlow: 'auth-callback' });
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: 'Authentication failed' });
    expect(warn).toHaveBeenCalledWith('Error', { status, error: 'Rate limit exceeded' });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('answers a 5xx status on a non-AppError with 500', () => {
    const res = fakeRes();
    respondWithError(res, Object.assign(new Error('upstream'), { status: 502 }), { log: 'Error', fallback: 'Failed' });
    expect(res.statusCode).toBe(500);
  });

  it('answers every NotFoundError with the notFound body when given', () => {
    const res = fakeRes();
    respondWithError(res, new NotFoundError('Account not found'), {
      log: 'Error',
      fallback: 'Failed',
      notFound: 'Invitation not found',
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Invitation not found' });
    expect(warn).toHaveBeenCalledWith('Error', { status: 404, error: 'Account not found' });
  });

  it('ends a response a stream already started and logs it as a 500', () => {
    const res = fakeRes(true);
    const err = new Error('pipe broke');
    respondWithError(res, err, { log: 'Error exporting', fallback: 'Failed', sentryFlow: 'export' });
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
    expect(error).toHaveBeenCalledWith('Error exporting', { streamed: true, status: 500, error: 'pipe broke' });
    expect(mockCapture).toHaveBeenCalledWith(err, REQ, { flow: 'export' });
  });
});
