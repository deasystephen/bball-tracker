/**
 * app.config.js decides, at build / OTA-publish time, which API host every device
 * calls (domain migration PR3, D16). An `eas update` run with APP_ENV unset once
 * shipped apiUrl=127.0.0.1 to every device (CLAUDE.md "OTA env gotcha"); this pins
 * the mapping so that footgun is a red test, and pins the Universal Links
 * entitlement so the next native build cannot silently carry the old domain.
 */
import { APP_URL_SCHEME } from '../config/env';

type ExpoConfig = {
  expo: {
    version: string;
    scheme: string | string[];
    ios: { associatedDomains: string[] };
    extra: { apiUrl: string; appEnv: string };
  };
};

/** [major, minor, patch] compare; true when `version` >= `floor`. */
function atLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const ENV_KEYS = ['APP_ENV', 'API_URL'] as const;

async function loadConfig(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<ExpoConfig> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    let config: ExpoConfig | undefined;
    jest.isolateModules(() => {
      // CommonJS Jest: jest.requireActual evaluates app.config.js fresh with the env above.
      const mod = jest.requireActual<{ default?: ExpoConfig } & ExpoConfig>('../app.config.js');
      config = mod.default ?? mod;
    });
    return config!;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

describe('app.config.js', () => {
  it('APP_ENV=production → production API host', async () => {
    expect((await loadConfig({ APP_ENV: 'production' })).expo.extra.apiUrl).toBe('https://api.hooplings.com');
  });

  it('APP_ENV=preview → production API host', async () => {
    expect((await loadConfig({ APP_ENV: 'preview' })).expo.extra.apiUrl).toBe('https://api.hooplings.com');
  });

  it('APP_ENV unset → local dev server (the OTA env footgun)', async () => {
    const cfg = await loadConfig({});
    expect(cfg.expo.extra.apiUrl).toBe('http://127.0.0.1:3000');
    expect(cfg.expo.extra.appEnv).toBe('development');
  });

  it('API_URL overrides the host in production and preview', async () => {
    expect((await loadConfig({ APP_ENV: 'production', API_URL: 'https://override.example.test' })).expo.extra.apiUrl).toBe(
      'https://override.example.test'
    );
  });

  it('Universal Links entitlement names the current apex', async () => {
    expect((await loadConfig({ APP_ENV: 'production' })).expo.ios.associatedDomains).toEqual(['applinks:hooplings.com']);
  });

  // URL scheme rename (#504); the pre-rename scheme overlap ended with #513,
  // so the binary registers exactly one scheme. The sign-in redirect asks for
  // APP_URL_SCHEME explicitly rather than reading this value.
  it('registers only the current scheme', async () => {
    expect((await loadConfig({ APP_ENV: 'production' })).expo.scheme).toEqual('hooplings');
  });

  it('registers the scheme the sign-in redirect asks for (config/env APP_URL_SCHEME)', async () => {
    const { scheme } = (await loadConfig({ APP_ENV: 'production' })).expo;
    expect(Array.isArray(scheme) ? scheme : [scheme]).toContain(APP_URL_SCHEME);
  });

  it('keeps the OTA runtime at or past the 1.3.0 scheme boundary', async () => {
    // expo-linking resolves the redirect scheme from the OTA manifest. Every
    // manifest that names `hooplings` must stay unreachable from the 1.2.0
    // binaries (#25-#30), which register only the old scheme: runtimeVersion
    // policy is appVersion, so the version can never drop below 1.3.0 again.
    expect(atLeast((await loadConfig({ APP_ENV: 'production' })).expo.version, '1.3.0')).toBe(true);
  });
});
