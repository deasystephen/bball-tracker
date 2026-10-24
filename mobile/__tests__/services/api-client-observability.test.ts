/**
 * The api-client's observability interceptor (#617), exercised through the
 * real module and real axios with only the network replaced by an adapter:
 *   - every request leaves an `http` breadcrumb with the redacted route
 *     pattern, status and duration;
 *   - a network failure or a 5xx is captured with `endpoint_pattern` and
 *     `status` tags; a 4xx is a breadcrumb only; a cancellation is a
 *     `warning` breadcrumb (`reason: 'ERR_CANCELED'`) and is never captured;
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
  default: { expoConfig: { version: '1.6.0', extra: { apiUrl: 'https://api.example.test' } } },
}));

const authState = { accessToken: 'tok_abc' as string | null, refreshToken: null as string | null, epoch: 0 };
jest.mock('../../store/auth-store', () => ({
  __esModule: true,
  getLogoutEpoch: () => authState.epoch,
  useAuthStore: {
    getState: () => ({
      accessToken: authState.accessToken,
      refreshToken: authState.refreshToken,
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

type Reply = { status: number; data?: unknown; headers?: Record<string, string> } | { throw: AxiosError };
let reply: (config: InternalAxiosRequestConfig) => Reply;

// A custom adapter settles nothing itself: a non-2xx has to be thrown as the
// AxiosError the built-in adapters would produce.
const adapter: AxiosAdapter = async (config) => {
  const r = reply(config);
  if ('throw' in r) throw r.throw;
  const response = { status: r.status, statusText: '', data: r.data ?? {}, headers: r.headers ?? {}, config };
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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const crumbs = () => mockedCrumb.mock.calls.map((c) => c[0]);
const lastCrumb = () => crumbs()[crumbs().length - 1];

describe('api-client observability (#617)', () => {
  beforeAll(() => {
    apiClient.defaults.adapter = adapter;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authState.accessToken = 'tok_abc';
    authState.refreshToken = null;
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
        request_id: expect.stringMatching(UUID_V4),
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
    expect(tags).toEqual({ endpoint_pattern: '/api/v1/games/:id', status: 503, request_id: expect.stringMatching(UUID_V4) });
  });

  it('does not capture a retryable 503 (Retry-After), only a warning breadcrumb', async () => {
    reply = () => ({
      status: 503,
      data: { error: 'Another request is still being processed', code: 'transaction_timeout' },
      headers: { 'retry-after': '5' },
    });

    await expect(apiClient.post('/teams/12345/invitations', {})).rejects.toBeDefined();

    expect(lastCrumb()).toMatchObject({ level: 'warning', data: { status_code: 503 } });
    expect(mockedCapture).not.toHaveBeenCalled();
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
      { endpoint_pattern: '/api/v1/auth/me', status: 'network', request_id: expect.stringMatching(UUID_V4) }
    );
  });

  it('does not capture a cancelled request', async () => {
    reply = (config) => ({ throw: networkError(config, 'ERR_CANCELED') });

    await expect(apiClient.get('/teams')).rejects.toMatchObject({ code: 'ERR_CANCELED' });

    expect(mockedCrumb).toHaveBeenCalledTimes(1);
    expect(lastCrumb()).toMatchObject({
      category: 'http',
      level: 'warning',
      data: { method: 'GET', url: '/api/v1/teams', reason: 'ERR_CANCELED' },
    });
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

  describe('request headers (#963)', () => {
    const sent: InternalAxiosRequestConfig[] = [];
    const header = (config: InternalAxiosRequestConfig, name: string): unknown => config.headers.get(name);

    beforeEach(() => {
      sent.length = 0;
      reply = (config) => {
        sent.push(config);
        return { status: 200, data: { ok: true } };
      };
    });

    it('sends a fresh UUID v4 X-Request-Id on every request', async () => {
      await apiClient.get('/teams');
      await apiClient.post('/teams', { name: 'x' });

      const ids = sent.map((config) => header(config, 'X-Request-Id'));
      expect(ids).toEqual([expect.stringMatching(UUID_V4), expect.stringMatching(UUID_V4)]);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('crumbs the request id the request was sent with', async () => {
      await apiClient.get('/teams');
      expect(lastCrumb().data.request_id).toBe(header(sent[0], 'X-Request-Id'));
    });

    it('tags a captured 5xx with the request id the API logged', async () => {
      reply = (config) => {
        sent.push(config);
        return { status: 500, data: { error: 'boom' } };
      };
      await expect(apiClient.get('/teams')).rejects.toBeDefined();

      const [, , tags] = mockedCapture.mock.calls[0];
      expect(tags.request_id).toBe(header(sent[0], 'X-Request-Id'));
      expect(lastCrumb().data.request_id).toBe(tags.request_id);
    });

    it('does not capture a 4xx, whatever its request id', async () => {
      reply = (config) => {
        sent.push(config);
        return { status: 404, data: { error: 'Not found' } };
      };
      await expect(apiClient.get('/teams/12345')).rejects.toBeDefined();
      expect(mockedCapture).not.toHaveBeenCalled();
      expect(lastCrumb().data.request_id).toBe(header(sent[0], 'X-Request-Id'));
    });

    it('sends X-Hooplings-Client with the platform and app version', async () => {
      await apiClient.get('/teams');
      // jest-expo runs as iOS; jest.setup.js has no ExpoUpdates native module, so
      // the bundled JS is what runs.
      expect(header(sent[0], 'X-Hooplings-Client')).toBe('ios/1.6.0+embedded');
    });

    it('gives the refresh and the replay of a 401 their own request ids', async () => {
      authState.refreshToken = 'refresh_1';
      let first = true;
      reply = (config) => {
        sent.push(config);
        if (config.url === '/auth/refresh') return { status: 200, data: { accessToken: 'tok_new', refreshToken: 'refresh_2' } };
        if (first) {
          first = false;
          return { status: 401, data: { error: 'expired' } };
        }
        return { status: 200, data: { ok: true } };
      };

      await apiClient.get('/teams');

      expect(sent.map((config) => config.url)).toEqual(['/teams', '/auth/refresh', '/teams']);
      const ids = sent.map((config) => header(config, 'X-Request-Id'));
      expect(new Set(ids).size).toBe(3);
      expect(lastCrumb().data.request_id).toBe(ids[2]);
    });

    it('stamps a public request sent without a session', async () => {
      authState.accessToken = null;
      await apiClient.get('/invitations/by-token/abcdefghijklmnop');
      expect(header(sent[0], 'X-Request-Id')).toEqual(expect.stringMatching(UUID_V4));
    });

    it('never stamps a request refused on the device for lack of a session', async () => {
      authState.accessToken = null;
      await expect(apiClient.get('/teams')).rejects.toBeInstanceOf(NoSessionError);
      expect(sent).toHaveLength(0);
      expect(lastCrumb().data).not.toHaveProperty('request_id');
      expect(mockedCapture.mock.calls[0][2]).not.toHaveProperty('request_id');
    });
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
