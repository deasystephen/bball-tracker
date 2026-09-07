/**
 * config/env.ts is the single source for the API host (domain migration PR3, D11).
 * Resolution: extra.apiUrl from app.config.js → dev server under __DEV__ → production API.
 */
type EnvModule = typeof import('../../config/env');

// Jest runs CommonJS here (no --experimental-vm-modules), so a fresh copy of the
// module comes from jest.requireActual inside isolateModules; its own
// `expo-constants` import still resolves through the mock registry.
const loadEnv = async (apiUrl: unknown, dev: boolean): Promise<EnvModule> => {
  let mod: EnvModule | undefined;
  jest.isolateModules(() => {
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: apiUrl === undefined ? {} : { apiUrl } } },
    }));
    (global as unknown as { __DEV__: boolean }).__DEV__ = dev;
    mod = jest.requireActual<EnvModule>('../../config/env');
  });
  return mod!;
};

describe('config/env getApiUrl()', () => {
  const originalDev = (global as unknown as { __DEV__: boolean }).__DEV__;
  afterEach(() => {
    (global as unknown as { __DEV__: boolean }).__DEV__ = originalDev;
    jest.dontMock('expo-constants');
  });

  it('prefers extra.apiUrl from app.config.js whatever the build mode', async () => {
    expect((await loadEnv('https://configured.example.test', true)).getApiUrl()).toBe('https://configured.example.test');
    expect((await loadEnv('https://configured.example.test', false)).getApiUrl()).toBe('https://configured.example.test');
  });

  it('falls back to the local dev server under __DEV__ when nothing is configured', async () => {
    const env = await loadEnv(undefined, true);
    expect(env.getApiUrl()).toBe(env.DEV_API_URL);
    expect(env.DEV_API_URL).toBe('http://127.0.0.1:3000');
  });

  it('falls back to the production API in release builds when nothing is configured', async () => {
    const env = await loadEnv(undefined, false);
    expect(env.getApiUrl()).toBe(env.PRODUCTION_API_URL);
    expect(env.PRODUCTION_API_URL).toBe('https://api.hooplings.com');
  });

  it('treats an empty configured value as unset', async () => {
    expect((await loadEnv('', false)).getApiUrl()).toBe('https://api.hooplings.com');
  });

  it('exposes the same value through the legacy config object', async () => {
    const env = await loadEnv('https://configured.example.test', true);
    expect(env.config.apiUrl).toBe(env.getApiUrl());
  });
});
