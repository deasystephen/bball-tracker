import { queryClient, shouldRetryQuery, QUERY_RETRIES } from '../../services/query-client';
import { NoSessionError, isNoSessionError, NO_SESSION_CODE } from '../../services/no-session-error';

const config = { url: '/teams', headers: {} } as never;

describe('shouldRetryQuery', () => {
  it('retries an ordinary failure once, as before', () => {
    expect(QUERY_RETRIES).toBe(1);
    expect(shouldRetryQuery(0, new Error('Network Error'))).toBe(true);
    expect(shouldRetryQuery(1, new Error('Network Error'))).toBe(false);
    expect(shouldRetryQuery(0, { response: { status: 500 } })).toBe(true);
  });

  // #582: the request was refused on the device because there is no session.
  // It fails the same way a second later.
  it('never retries a request refused for lack of a session', () => {
    expect(shouldRetryQuery(0, new NoSessionError(config))).toBe(false);
  });

  it('is what the app-wide query client uses', () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(shouldRetryQuery);
  });
});

describe('NoSessionError', () => {
  it('carries a message a screen can show, a code, and the request it refused', () => {
    const error = new NoSessionError(config);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NoSessionError');
    expect(error.message).toBe('You are signed out');
    expect(error.code).toBe(NO_SESSION_CODE);
    expect(error.config).toBe(config);
  });

  it('is recognised by identity, not by a look-alike code', () => {
    expect(isNoSessionError(new NoSessionError(config))).toBe(true);
    expect(isNoSessionError({ code: NO_SESSION_CODE, message: 'You are signed out' })).toBe(false);
    expect(isNoSessionError(new Error('You are signed out'))).toBe(false);
    expect(isNoSessionError(null)).toBe(false);
  });
});
