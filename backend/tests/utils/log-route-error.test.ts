import { logRouteError } from '../../src/utils/log-route-error';
import { logger } from '../../src/utils/logger';

describe('logRouteError (#656)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it.each([400, 401, 402, 403, 404, 409, 429])('logs a %i response at warn', (status) => {
    logRouteError({ statusCode: status }, 'Error doing X', new Error('nope'));
    expect(warn).toHaveBeenCalledWith('Error doing X', { status, error: 'nope' });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([500, 503])('logs a %i response at error', (status) => {
    logRouteError({ statusCode: status }, 'Error doing X', new Error('boom'));
    expect(error).toHaveBeenCalledWith('Error doing X', { status, error: 'boom' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs at error when no error status was set (called before the response)', () => {
    logRouteError({ statusCode: 200 }, 'Error doing X', new Error('boom'));
    expect(error).toHaveBeenCalledWith('Error doing X', { status: 200, error: 'boom' });
  });

  it('stringifies a non-Error throw and keeps extra context', () => {
    logRouteError({ statusCode: 404 }, 'Error doing X', 'plain string', { teamId: 't1' });
    expect(warn).toHaveBeenCalledWith('Error doing X', { teamId: 't1', status: 404, error: 'plain string' });
  });
});
