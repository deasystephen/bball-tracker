/**
 * Tests for api-client.
 *
 * jest.setup.js mocks the api-client module for all other tests, but here
 * we want to exercise the real module — so we jest.unmock() it and load
 * it per-test via jest.requireActual after resetModules. We mock axios at the network boundary and verify:
 *   - baseURL is built correctly for both __DEV__ and configured apiUrl
 *   - the request interceptor attaches a Bearer token when present
 *   - the response interceptor refreshes + retries on 401, and only logs
 *     out when no refresh is possible (regression for #349: the app used to
 *     log out on the first expired access token)
 */

jest.unmock('../../services/api-client');

// Capture the request + response interceptor handlers that the real module
// registers so we can invoke them directly.
type Handler<T, R> = (input: T) => R | Promise<R>;
const captured = {
  request: null as Handler<Record<string, unknown>, unknown> | null,
  requestError: null as Handler<unknown, unknown> | null,
  response: null as Handler<unknown, unknown> | null,
  responseError: null as Handler<unknown, unknown> | null,
  createConfig: null as Record<string, unknown> | null,
};

jest.mock('axios', () => {
  const create = jest.fn((config: Record<string, unknown>) => {
    captured.createConfig = config;
    return {
      interceptors: {
        request: {
          use: (onOk: Handler<Record<string, unknown>, unknown>, onErr: Handler<unknown, unknown>) => {
            captured.request = onOk;
            captured.requestError = onErr;
          },
        },
        response: {
          use: (onOk: Handler<unknown, unknown>, onErr: Handler<unknown, unknown>) => {
            captured.response = onOk;
            captured.responseError = onErr;
          },
        },
      },
    };
  });
  return { __esModule: true, default: { create }, create };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
}));

jest.mock('../../store/auth-store', () => {
  const state = { accessToken: null as string | null, logoutCalls: 0 };
  return {
    __esModule: true,
    __state: state,
    useAuthStore: {
      getState: () => ({
        accessToken: state.accessToken,
        logout: () => {
          state.logoutCalls += 1;
        },
      }),
    },
  };
});

describe('api-client', () => {
  beforeEach(() => {
    jest.resetModules();
    captured.request = null;
    captured.requestError = null;
    captured.response = null;
    captured.responseError = null;
    captured.createConfig = null;
  });

  const loadModule = () => {
    // Re-register mocks after resetModules.
    jest.doMock('axios', () => {
      const create = jest.fn((config: Record<string, unknown>) => {
        captured.createConfig = config;
        return {
          interceptors: {
            request: {
              use: (onOk: Handler<Record<string, unknown>, unknown>, onErr: Handler<unknown, unknown>) => {
                captured.request = onOk;
                captured.requestError = onErr;
              },
            },
            response: {
              use: (onOk: Handler<unknown, unknown>, onErr: Handler<unknown, unknown>) => {
                captured.response = onOk;
                captured.responseError = onErr;
              },
            },
          },
        };
      });
      return { __esModule: true, default: { create }, create };
    });
  };

  it('creates axios with configured apiUrl + /api/v1 suffix + JSON headers', () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    jest.requireActual('../../services/api-client');

    expect(captured.createConfig?.baseURL).toBe('https://example.test/api/v1');
    expect(captured.createConfig?.timeout).toBe(10000);
    expect(captured.createConfig?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
  });

  it('falls back to localhost in dev when no apiUrl is configured', () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: {} } },
    }));
    // __DEV__ is true in jest-expo test env by default.
    jest.requireActual('../../services/api-client');
    expect(captured.createConfig?.baseURL).toBe('http://127.0.0.1:3000/api/v1');
  });

  it('request interceptor adds Authorization header when a token is present', () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    const authMock = {
      state: { accessToken: 'jwt-xyz' as string | null, logoutCalls: 0 },
    };
    jest.doMock('../../store/auth-store', () => ({
      __esModule: true,
      useAuthStore: {
        getState: () => ({
          accessToken: authMock.state.accessToken,
          logout: () => {
            authMock.state.logoutCalls += 1;
          },
        }),
      },
    }));
    jest.requireActual('../../services/api-client');

    const config = { headers: {} as Record<string, string> };
    const result = captured.request!(config) as typeof config;
    expect(result.headers.Authorization).toBe('Bearer jwt-xyz');

    // When no token, no Authorization header is set.
    authMock.state.accessToken = null;
    const config2 = { headers: {} as Record<string, string> };
    const result2 = captured.request!(config2) as typeof config2;
    expect(result2.headers.Authorization).toBeUndefined();
  });

  it('request error handler rejects the error unchanged', async () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    jest.requireActual('../../services/api-client');
    const err = new Error('boom');
    await expect(captured.requestError!(err)).rejects.toBe(err);
  });

  it('response interceptor passes responses through unchanged', () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    jest.requireActual('../../services/api-client');
    const resp = { data: { ok: true }, status: 200 };
    expect(captured.response!(resp)).toBe(resp);
  });

  it('response error handler calls logout on 401 and always rejects', async () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    const authMock = { state: { accessToken: 't' as string | null, logoutCalls: 0 } };
    jest.doMock('../../store/auth-store', () => ({
      __esModule: true,
      useAuthStore: {
        getState: () => ({
          accessToken: authMock.state.accessToken,
          logout: () => {
            authMock.state.logoutCalls += 1;
          },
        }),
      },
    }));
    jest.requireActual('../../services/api-client');

    const err401 = { response: { status: 401 }, message: '401' };
    await expect(captured.responseError!(err401)).rejects.toBe(err401);
    expect(authMock.state.logoutCalls).toBe(1);

    const err500 = { response: { status: 500 }, message: '500' };
    await expect(captured.responseError!(err500)).rejects.toBe(err500);
    // 500 must NOT trigger logout.
    expect(authMock.state.logoutCalls).toBe(1);

    const errNoResponse = { message: 'network' };
    await expect(captured.responseError!(errNoResponse)).rejects.toBe(errNoResponse);
    expect(authMock.state.logoutCalls).toBe(1);
  });

  /**
   * Builds an axios mock whose created client also exposes post/request so the
   * refresh-and-retry path can run end to end, plus an auth-store mock with a
   * refresh token and a recording setAuthToken.
   */
  type RefreshResult = 'ok' | 'fail' | 'network' | { status: number };
  const refreshRejection = (r: RefreshResult) => {
    if (r === 'network') return { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' };
    if (r === 'fail') return { isAxiosError: true, response: { status: 401 } };
    return { isAxiosError: true, response: { status: (r as { status: number }).status } };
  };

  const loadRefreshable = (opts: { refreshToken: string | null; refreshResult: RefreshResult }) => {
    const calls = { post: [] as unknown[][], request: [] as unknown[][], logoutCalls: 0, setTokens: [] as unknown[][] };
    const auth = { accessToken: 'stale' as string | null, refreshToken: opts.refreshToken };
    jest.doMock('axios', () => {
      const create = jest.fn(() => ({
        interceptors: {
          request: { use: (onOk: Handler<Record<string, unknown>, unknown>) => { captured.request = onOk; } },
          response: {
            use: (onOk: Handler<unknown, unknown>, onErr: Handler<unknown, unknown>) => {
              captured.response = onOk;
              captured.responseError = onErr;
            },
          },
        },
        post: jest.fn((...args: unknown[]) => {
          calls.post.push(args);
          return opts.refreshResult === 'ok'
            ? Promise.resolve({ data: { accessToken: 'fresh', refreshToken: 'fresh-refresh' } })
            : Promise.reject(refreshRejection(opts.refreshResult));
        }),
        request: jest.fn((...args: unknown[]) => {
          calls.request.push(args);
          return Promise.resolve({ data: { retried: true } });
        }),
      }));
      return { __esModule: true, default: { create }, create };
    });
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    jest.doMock('../../store/auth-store', () => ({
      __esModule: true,
      useAuthStore: {
        getState: () => ({
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
          setAuthToken: (token: string, refresh: string | null) => {
            calls.setTokens.push([token, refresh]);
            auth.accessToken = token;
            auth.refreshToken = refresh;
          },
          logout: () => {
            calls.logoutCalls += 1;
          },
        }),
      },
    }));
    jest.requireActual('../../services/api-client');
    return { calls, auth };
  };

  const make401 = (url: string) => ({
    response: { status: 401 },
    config: { url, headers: { Authorization: 'Bearer stale' } as Record<string, string> },
    message: '401',
  });

  it('refreshes the token and replays the request on 401 instead of logging out', async () => {
    const { calls } = loadRefreshable({ refreshToken: 'r1', refreshResult: 'ok' });
    const err = make401('/teams');

    const result = await captured.responseError!(err);

    expect(calls.post).toEqual([['/auth/refresh', { refreshToken: 'r1' }]]);
    expect(calls.setTokens).toEqual([['fresh', 'fresh-refresh']]);
    // Original request replayed with the new bearer, not the stale one.
    expect(calls.request).toHaveLength(1);
    expect(err.config.headers.Authorization).toBe('Bearer fresh');
    expect(result).toEqual({ data: { retried: true } });
    expect(calls.logoutCalls).toBe(0);
  });

  it('logs out when the refresh token is rejected', async () => {
    const { calls } = loadRefreshable({ refreshToken: 'r1', refreshResult: 'fail' });
    const err = make401('/teams');

    await expect(captured.responseError!(err)).rejects.toBe(err);
    expect(calls.post).toHaveLength(1);
    expect(calls.request).toHaveLength(0);
    expect(calls.logoutCalls).toBe(1);
  });

  it('logs out without attempting a refresh when no refresh token is stored', async () => {
    const { calls } = loadRefreshable({ refreshToken: null, refreshResult: 'ok' });
    const err = make401('/teams');

    await expect(captured.responseError!(err)).rejects.toBe(err);
    expect(calls.post).toHaveLength(0);
    expect(calls.logoutCalls).toBe(1);
  });

  it('never tries to refresh for auth endpoints or an already-retried request', async () => {
    const { calls } = loadRefreshable({ refreshToken: 'r1', refreshResult: 'ok' });

    // A 401 from /auth/refresh is handled by refreshAccessToken's caller, not
    // by the interceptor — it neither refreshes nor logs out here.
    const refreshErr = make401('/auth/refresh');
    await expect(captured.responseError!(refreshErr)).rejects.toBe(refreshErr);
    expect(calls.logoutCalls).toBe(0);

    // The replayed request 401'd with a fresh token: the session is gone.
    const retried = { ...make401('/teams'), config: { ...make401('/teams').config, _retry: true } };
    await expect(captured.responseError!(retried)).rejects.toBe(retried);

    expect(calls.post).toHaveLength(0);
    expect(calls.logoutCalls).toBe(1);
  });

  // Audit #20: a WorkOS/backend outage during refresh must not destroy the
  // session. Only a definitive 401 from /auth/refresh means "re-login".
  describe.each([
    ['503 service unavailable', { status: 503 } as RefreshResult],
    ['500 server error', { status: 500 } as RefreshResult],
    ['429 rate limited', { status: 429 } as RefreshResult],
    ['network timeout', 'network' as RefreshResult],
  ])('keeps the session when the refresh fails with %s', (_label, refreshResult) => {
    it('does not log out, does not replay, and surfaces the original error', async () => {
      const { calls, auth } = loadRefreshable({ refreshToken: 'r1', refreshResult });
      const err = make401('/teams');

      await expect(captured.responseError!(err)).rejects.toBe(err);

      expect(calls.post).toHaveLength(1);
      expect(calls.request).toHaveLength(0);
      expect(calls.logoutCalls).toBe(0);
      expect(calls.setTokens).toHaveLength(0);
      expect(auth.refreshToken).toBe('r1');
    });
  });

  it('a later 401 retries the refresh after a transient failure (single-flight slot is released)', async () => {
    const { calls } = loadRefreshable({ refreshToken: 'r1', refreshResult: { status: 503 } });
    await expect(captured.responseError!(make401('/teams'))).rejects.toBeDefined();
    await expect(captured.responseError!(make401('/games'))).rejects.toBeDefined();
    expect(calls.post).toHaveLength(2);
    expect(calls.logoutCalls).toBe(0);
  });

  describe('refreshAccessToken (exported)', () => {
    it('reports ok with the new access token', async () => {
      loadRefreshable({ refreshToken: 'r1', refreshResult: 'ok' });
      const { refreshAccessToken } = jest.requireActual('../../services/api-client');
      await expect(refreshAccessToken()).resolves.toEqual({ status: 'ok', accessToken: 'fresh' });
    });

    it('reports rejected on 401 and when no refresh token is stored', async () => {
      loadRefreshable({ refreshToken: 'r1', refreshResult: 'fail' });
      const mod = jest.requireActual('../../services/api-client');
      await expect(mod.refreshAccessToken()).resolves.toEqual({ status: 'rejected' });

      jest.resetModules();
      const { calls } = loadRefreshable({ refreshToken: null, refreshResult: 'ok' });
      const mod2 = jest.requireActual('../../services/api-client');
      await expect(mod2.refreshAccessToken()).resolves.toEqual({ status: 'rejected' });
      expect(calls.post).toHaveLength(0);
    });

    it('reports unavailable with the underlying error on 5xx/network failures', async () => {
      loadRefreshable({ refreshToken: 'r1', refreshResult: { status: 503 } });
      const { refreshAccessToken } = jest.requireActual('../../services/api-client');
      const outcome = await refreshAccessToken();
      expect(outcome.status).toBe('unavailable');
      expect(outcome.error).toMatchObject({ response: { status: 503 } });
    });
  });

  it('coalesces concurrent 401s into a single refresh call', async () => {
    const { calls } = loadRefreshable({ refreshToken: 'r1', refreshResult: 'ok' });

    await Promise.all([
      captured.responseError!(make401('/teams')),
      captured.responseError!(make401('/games')),
      captured.responseError!(make401('/invitations')),
    ]);

    // WorkOS rotates refresh tokens: a second parallel call would be rejected.
    expect(calls.post).toHaveLength(1);
    expect(calls.request).toHaveLength(3);
    expect(calls.logoutCalls).toBe(0);
  });
});
