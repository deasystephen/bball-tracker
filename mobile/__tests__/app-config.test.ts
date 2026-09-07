/**
 * app.config.js decides, at build / OTA-publish time, which API host every device
 * calls (domain migration PR3, D16). An `eas update` run with APP_ENV unset once
 * shipped apiUrl=127.0.0.1 to every device (CLAUDE.md "OTA env gotcha"); this pins
 * the mapping so that footgun is a red test, and pins the Universal Links
 * entitlement so the next native build cannot silently carry the old domain.
 */
type ExpoConfig = {
  expo: {
    ios: { associatedDomains: string[] };
    extra: { apiUrl: string; appEnv: string };
  };
};

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
});
