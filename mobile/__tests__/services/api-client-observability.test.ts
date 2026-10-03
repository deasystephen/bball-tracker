/**
 * The api-client's observability interceptor (#617), exercised through the
 * real module and real axios with only the network replaced by an adapter:
 *   - every request leaves an `http` breadcrumb with the redacted route
 *     pattern, status and duration;
 *   - a network failure or a 5xx is captured with `endpoint_pattern` and
 *     `status` tags; a 4xx is a breadcrumb only; a cancellation is neither;
 *   - a request refused for lack of a session (`NoSessionError`, #582) is
 *     captured once per endpoint pattern per session end, not per retry;
 *   - nothing captured or crumbed carries a token, an OAuth code or an email.
 */

import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { apiClient, NoSessionError } from '../../services/api-client';
import { addBreadcrumb, captureException } from '../../services/sentry';

// Hoisted above the imports by babel-jest. jest.setup.js mocks the api-client
// for every suite; this one needs the real one.
jest.unmock('../../services/api-client');

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'https://api.example.test' } } },
}));

const authState = { accessToken: 'tok_abc' as string | null, epoch: 0 };
jest.mock('../../store/auth-store', () => ({
  __esModule: true,
  getLogoutEpoch: () => authState.epoch,
  useAuthStore: {
    getState: () => ({
      accessToken: authState.accessToken,
      refreshToken: null,
      setAuthToken: jest.fn(),
      clearSession: jest.fn(),
    }),
  },
}));

jest.mock('../../services/sentry', () => {
  const actual = jest.requireActual<typeof import('../../services/sentry')>('../../services/sentry');
  return {
    __esModule: true,
    endpointPattern: actual.endpointPattern,
    addBreadcrumb: jest.fn(),
    captureException: jest.fn(),
  };
});

const mockedCrumb = addBreadcrumb as jest.Mock;
const mockedCapture = captureException as jest.Mock;

type Reply = { status: number; data?: unknown } | { throw: AxiosError };
let reply: (config: InternalAxiosRequestConfig) => Reply;

// A custom adapter settles nothing itself: a non-2xx has to be thrown as the
// AxiosError the built-in adapters would produce.
const adapter: AxiosAdapter = async (config) => {
  const r = reply(config);
  if ('throw' in r) throw r.throw;
  const response = { status: r.status, statusText: '', data: r.data ?? {}, headers: {}, config };
  if (r.status >= 400) {
    throw new AxiosError(
      `Request failed with status code ${r.status}`,
      r.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      undefined,
      response
    );
  }
  return response;
};

const networkError = (config: InternalAxiosRequestConfig, code = 'ERR_NETWORK'): AxiosError =>
  new AxiosError('Network Error', code, config);

const crumbs = () => mockedCrumb.mock.calls.map((c) => c[0]);
const lastCrumb = () => crumbs()[crumbs().length - 1];

describe('api-client observability (#617)', () => {
  beforeAll(() => {
    apiClient.defaults.adapter = adapter;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authState.accessToken = 'tok_abc';
    reply = () => ({ status: 200, data: { ok: true } });
  });

  it('leaves an http breadcrumb for a successful request with the id-collapsed route', async () => {
    await apiClient.get('/teams/4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b/games');

    expect(mockedCrumb).toHaveBeenCalledTimes(1);
    expect(lastCrumb()).toEqual({
      category: 'http',
      type: 'http',
      data: {
        method: 'GET',
        url: '/api/v1/teams/:id/games',
        status_code: 200,
        duration: expect.any(Number),
      },
    });
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it('crumbs a 4xx as a warning and does not capture it', async () => {
    reply = () => ({ status: 403, data: { error: 'You do not have permission' } });

    await expect(apiClient.post('/teams', { name: 'x' })).rejects.toMatchObject({ message: 'You do not have permission' });

    expect(lastCrumb()).toMatchObject({
      category: 'http',
      level: 'warning',
      data: { method: 'POST', url: '/api/v1/teams', status_code: 403 },
    });
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it('captures a 5xx with endpoint_pattern and status tags', async () => {
    reply = () => ({ status: 503, data: { error: 'down' } });

    await expect(apiClient.get('/games/12345')).rejects.toBeDefined();

    expect(lastCrumb()).toMatchObject({ level: 'error', data: { url: '/api/v1/games/:id', status_code: 503 } });
    expect(mockedCapture).toHaveBeenCalledTimes(1);
    const [error, context, tags] = mockedCapture.mock.calls[0];
    expect(error).toBeInstanceOf(AxiosError);
    expect(context).toEqual({ endpoint: '/api/v1/games/:id' });
    expect(tags).toEqual({ endpoint_pattern: '/api/v1/games/:id', status: 503 });
  });

  it('captures a network failure with status "network" and the axios code', async () => {
    reply = (config) => ({ throw: networkError(config) });

    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({ code: 'ERR_NETWORK' });

    expect(lastCrumb()).toMatchObject({
      level: 'error',
      data: { method: 'GET', url: '/api/v1/auth/me', reason: 'ERR_NETWORK' },
    });
    expect(lastCrumb().data).not.toHaveProperty('status_code', expect.anything());
    expect(mockedCapture).toHaveBeenCalledWith(
      expect.any(AxiosError),
      { endpoint: '/api/v1/auth/me', code: 'ERR_NETWORK' },
      { endpoint_pattern: '/api/v1/auth/me', status: 'network' }
    );
  });

  it('does not capture a cancelled request', async () => {
    reply = (config) => ({ throw: networkError(config, 'ERR_CANCELED') });

    await expect(apiClient.get('/teams')).rejects.toMatchObject({ code: 'ERR_CANCELED' });

    expect(mockedCrumb).toHaveBeenCalledTimes(1);
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it('reports a NoSessionError once per endpoint pattern per session end', async () => {
    authState.accessToken = null;

    for (let i = 0; i < 3; i++) {
      await expect(apiClient.get('/auth/me/usage')).rejects.toBeInstanceOf(NoSessionError);
    }
    await expect(apiClient.get('/teams')).rejects.toBeInstanceOf(NoSessionError);

    // Every refusal is a breadcrumb; only the first per pattern is captured.
    expect(crumbs().filter((c) => c.data?.url === '/api/v1/auth/me/usage')).toHaveLength(3);
    expect(crumbs()[0]).toMatchObject({
      category: 'http',
      level: 'warning',
      data: { method: 'GET', url: '/api/v1/auth/me/usage', reason: 'ERR_NO_SESSION' },
    });
    expect(mockedCapture.mock.calls.map((c) => c[2])).toEqual([
      { endpoint_pattern: '/api/v1/auth/me/usage', status: 'no_session' },
      { endpoint_pattern: '/api/v1/teams', status: 'no_session' },
    ]);

    // The next session end reports again.
    authState.epoch += 1;
    await expect(apiClient.get('/auth/me/usage')).rejects.toBeInstanceOf(NoSessionError);
    expect(mockedCapture).toHaveBeenCalledTimes(3);
  });

  it('never crumbs or captures a token, OAuth code or email', async () => {
    reply = () => ({ status: 500, data: { error: 'boom' } });

    await expect(
      apiClient.get('/invitations/by-token/abcdefghijklmnop', { params: { email: 'coach@example.test' } })
    ).rejects.toBeDefined();
    await expect(apiClient.get('/auth/callback?code=OAUTHCODE&state=STATE')).rejects.toBeDefined();

    const everything = JSON.stringify([mockedCrumb.mock.calls, mockedCapture.mock.calls.map((c) => c.slice(1))]);
    expect(everything).not.toContain('abcdefghijklmnop');
    expect(everything).not.toContain('OAUTHCODE');
    expect(everything).not.toContain('STATE');
    expect(everything).not.toContain('coach@example.test');
    expect(everything).not.toContain('tok_abc');
    expect(crumbs().map((c) => c.data.url)).toEqual([
      '/api/v1/invitations/by-token/[scrubbed]',
      '/api/v1/auth/callback',
    ]);
  });
});
