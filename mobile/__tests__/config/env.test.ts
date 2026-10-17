/**
 * config/env.ts is the single source for the API host (domain migration PR3, D11).
 * Resolution: extra.apiUrl from app.config.js (a loopback value is ignored in a
 * release bundle, #721) → dev server under __DEV__ → production API.
 */
type EnvModule = typeof import('../../config/env');

// Jest runs CommonJS here (no --experimental-vm-modules), so a fresh copy of the
// module comes from jest.requireActual inside isolateModules; its own
// `expo-constants` import still resolves through the mock registry.
const warn = jest.fn();

const loadEnv = async (apiUrl: unknown, dev: boolean): Promise<EnvModule> => {
  let mod: EnvModule | undefined;
  jest.isolateModules(() => {
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: apiUrl === undefined ? {} : { apiUrl } } },
    }));
    jest.doMock('../../services/log', () => ({
      log: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
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
    jest.dontMock('../../services/log');
    warn.mockReset();
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

  // #721: an OTA published with APP_ENV unset carries the dev host. A release
  // bundle never has a reason to call the phone's own loopback, so it fails
  // closed to the production API.
  describe('a loopback apiUrl in a release bundle', () => {
    const LOOPBACK_URLS = [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://10.0.2.2:3000',
      'http://[::1]:3000',
      'http://127.0.0.1:3000/',
      'http://localhost:3000/api',
      'http://10.0.2.2',
      'https://[::1]/v1',
      'HTTP://LOCALHOST:3000',
    ];

    it.each(LOOPBACK_URLS)('ignores %s and uses the production API', async (url) => {
      const env = await loadEnv(url, false);
      expect(env.getApiUrl()).toBe('https://api.hooplings.com');
      expect(env.config.apiUrl).toBe('https://api.hooplings.com');
    });

    it('logs one warning per launch, without the URL', async () => {
      const env = await loadEnv('http://127.0.0.1:3000', false);
      env.getApiUrl();
      env.getApiUrl();
      env.getApiUrl();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('getApiUrl: ignoring loopback apiUrl in a release bundle');
    });

    it.each(['https://localhost.example.test', 'http://127.0.0.10:3000', 'https://api.example.test/127.0.0.1'])(
      'keeps %s, which only looks like a loopback host',
      async (url) => {
        expect((await loadEnv(url, false)).getApiUrl()).toBe(url);
        expect(warn).not.toHaveBeenCalled();
      }
    );
  });

  it('keeps the loopback dev server under __DEV__, from the manifest or by default', async () => {
    const fromManifest = await loadEnv('http://127.0.0.1:3000', true);
    expect(fromManifest.getApiUrl()).toBe(fromManifest.DEV_API_URL);
    expect((await loadEnv('http://localhost:3000', true)).getApiUrl()).toBe('http://localhost:3000');
    const unset = await loadEnv(undefined, true);
    expect(unset.getApiUrl()).toBe(unset.DEV_API_URL);
    expect(warn).not.toHaveBeenCalled();
  });

  it('exposes the same value through the legacy config object', async () => {
    const env = await loadEnv('https://configured.example.test', true);
    expect(env.config.apiUrl).toBe(env.getApiUrl());
  });
});

describe('config/env SUPPORT_EMAIL (#450)', () => {
  it('is the address the backend puts in Reply-To and in the email footers', async () => {
    const { readFileSync } = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');
    const brand = readFileSync(
      path.resolve(__dirname, '../../../backend/src/services/mailer/templates/brand.ts'),
      'utf8'
    );
    const match = /^export const SUPPORT_EMAIL = '([^']+)';$/m.exec(brand);
    if (!match) throw new Error('backend brand.ts: could not find SUPPORT_EMAIL.');

    expect((await loadEnv(undefined, false)).SUPPORT_EMAIL).toBe(match[1]);
  });
});
