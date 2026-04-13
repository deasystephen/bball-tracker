/**
 * Tests for api-client.
 *
 * jest.setup.js mocks the api-client module for all other tests, but here
 * we want to exercise the real module — so we jest.unmock() it and require
 * it dynamically. We mock axios at the network boundary and verify:
 *   - baseURL is built correctly for both __DEV__ and configured apiUrl
 *   - the request interceptor attaches a Bearer token when present
 *   - the response interceptor calls logout on 401
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
    require('../../services/api-client');

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
    require('../../services/api-client');
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
    require('../../services/api-client');

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
    require('../../services/api-client');
    const err = new Error('boom');
    await expect(captured.requestError!(err)).rejects.toBe(err);
  });

  it('response interceptor passes responses through unchanged', () => {
    loadModule();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
    }));
    require('../../services/api-client');
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
    require('../../services/api-client');

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
});
