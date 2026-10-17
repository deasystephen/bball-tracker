import type { Response } from 'express';
import { respondWithError } from '../../src/utils/respond-with-error';
import {
  AppError,
  ConflictError,
  LastHeadCoachError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { captureException } from '../../src/utils/sentry';

jest.mock('../../src/utils/sentry', () => ({ captureException: jest.fn() }));
const mockCapture = captureException as jest.MockedFunction<typeof captureException>;

/** A Response double that records what was sent, like Express does. */
function fakeRes(headersSent = false): Response & { body?: unknown; ended: boolean } {
  const res = {
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

  it('answers anything else with the fallback body at 500, logs at error, reports the flow', () => {
    const res = fakeRes();
    const err = new Error('connection reset');
    respondWithError(res, err, { log: 'Error doing X', fallback: 'Failed to do X', sentryFlow: 'x-flow' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to do X' });
    expect(error).toHaveBeenCalledWith('Error doing X', { status: 500, error: 'connection reset' });
    expect(mockCapture).toHaveBeenCalledWith(err, { flow: 'x-flow' });
  });

  it('accepts a fallback body with extra fields', () => {
    const res = fakeRes();
    respondWithError(res, 'boom', { log: 'Error', fallback: { error: 'Failed', details: 'boom' } });
    expect(res.body).toEqual({ error: 'Failed', details: 'boom' });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('reports a 5xx AppError to Sentry and answers its own message', () => {
    const res = fakeRes();
    const err = new ServiceUnavailableError('Authentication service unavailable');
    respondWithError(res, err, { log: 'Error', fallback: 'Failed', sentryFlow: 'auth-me', context: { teamId: 't1' } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Authentication service unavailable' });
    expect(error).toHaveBeenCalledWith('Error', { teamId: 't1', status: 503, error: 'Authentication service unavailable' });
    expect(mockCapture).toHaveBeenCalledWith(err, { flow: 'auth-me' });
  });

  it('ends a response a stream already started instead of answering twice', () => {
    const res = fakeRes(true);
    respondWithError(res, new Error('pipe broke'), { log: 'Error exporting', fallback: 'Failed', sentryFlow: 'export' });
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
    expect(error).toHaveBeenCalledWith('Error exporting', { status: 200, error: 'pipe broke' });
    expect(mockCapture).toHaveBeenCalledWith(expect.any(Error), { flow: 'export' });
  });
});
