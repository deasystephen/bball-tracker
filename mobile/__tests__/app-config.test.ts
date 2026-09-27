/**
 * app.config.js decides, at build / OTA-publish time, which API host every device
 * calls (domain migration PR3, D16). An `eas update` run with APP_ENV unset once
 * shipped apiUrl=127.0.0.1 to every device (CLAUDE.md "OTA env gotcha"); this pins
 * the mapping so that footgun is a red test, and pins the Universal Links
 * entitlement so the next native build cannot silently carry the old domain.
 */
import path from 'path';

import { APP_URL_SCHEME } from '../config/env';

type PluginEntry = string | [string, Record<string, unknown>?];

type ExpoConfig = {
  expo: {
    version: string;
    scheme: string | string[];
    ios: { associatedDomains: string[]; infoPlist?: Record<string, unknown> };
    android: { permissions?: string[] };
    plugins: PluginEntry[];
    extra: { apiUrl: string; appEnv: string };
  };
};

/** The subset of `expo/config-plugins` the native-config evaluation below uses. */
type ConfigPlugins = {
  withPlugins: (config: Record<string, unknown>, plugins: PluginEntry[]) => Record<string, unknown>;
  compileModsAsync: (
    config: Record<string, unknown>,
    options: { projectRoot: string; introspect: boolean; platforms: ('ios' | 'android')[] }
  ) => Promise<NativeConfig>;
};

type ManifestPermission = { $: Record<string, string> };

type NativeConfig = {
  ios: { infoPlist: Record<string, unknown> };
  android?: { permissions?: string[] };
  _internal: {
    modResults: {
      android: { manifest: { manifest: { 'uses-permission'?: ManifestPermission[] } } };
    };
  };
};

/** Expo's config-plugin fallbacks — what ships when no purpose string is given. */
const EXPO_BOILERPLATE = /\$\(PRODUCT_NAME\)|^Allow .* to access your/;

const PROJECT_ROOT = path.resolve(__dirname, '..');

function pluginOptions(config: ExpoConfig, name: string): Record<string, unknown> | undefined {
  for (const entry of config.expo.plugins) {
    if (Array.isArray(entry) && entry[0] === name) return entry[1] ?? {};
  }
  return undefined;
}

/**
 * Runs the permission-bearing config plugins exactly as listed in
 * app.config.js and evaluates their mods in introspection mode — the same
 * evaluation as `npx expo config --type introspect`, minus the plugins that
 * do not touch permissions. No native project is generated.
 */
async function evaluateNativePermissions(config: ExpoConfig): Promise<NativeConfig> {
  const { withPlugins, compileModsAsync } = jest.requireActual<ConfigPlugins>('expo/config-plugins');
  const plugins = config.expo.plugins.filter(
    (entry) => Array.isArray(entry) && ['expo-image-picker', 'expo-secure-store'].includes(entry[0])
  );
  const base = {
    name: 'Hooplings',
    slug: 'bball-tracker',
    ios: { bundleIdentifier: 'com.bballtracker.mobile' },
    android: { package: 'com.bballtracker.mobile' },
    _internal: { projectRoot: PROJECT_ROOT },
  };
  return compileModsAsync(withPlugins(base, plugins), {
    projectRoot: PROJECT_ROOT,
    introspect: true,
    platforms: ['ios', 'android'],
  });
}

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

  it('keeps the OTA runtime at or past the 1.4.0 dependency boundary', async () => {
    // Build #31 (runtime 1.3.0) carries older native code for Amplitude,
    // Sentry and expo-updates than the JavaScript on main expects (#562). An
    // OTA from main must never reach it, so the version can never drop below
    // 1.4.0 again.
    expect(atLeast((await loadConfig({ APP_ENV: 'production' })).expo.version, '1.4.0')).toBe(true);
  });

  // Permission purpose strings (#451). Baked into Info.plist: a regression
  // here is invisible until App Review reads the prompt, and an OTA cannot
  // fix it. The strings are set through the plugin options because prebuild
  // applies expo-image-picker / expo-secure-store with boilerplate defaults.
  describe('permission purpose strings', () => {
    it('sets camera and photo purpose strings that name the product and are not Expo boilerplate', async () => {
      const options = pluginOptions(await loadConfig({ APP_ENV: 'production' }), 'expo-image-picker');
      expect(options).toBeDefined();
      for (const key of ['cameraPermission', 'photosPermission']) {
        const value = options?.[key];
        expect(typeof value).toBe('string');
        expect(value).toContain('Hooplings');
        expect(value).toMatch(/profile photo/);
        expect(value).not.toMatch(EXPO_BOILERPLATE);
      }
      expect(options?.cameraPermission).toMatch(/camera/);
      expect(options?.photosPermission).toMatch(/photo library/);
    });

    it('disables the microphone and Face ID permissions the app never uses', async () => {
      const config = await loadConfig({ APP_ENV: 'production' });
      expect(pluginOptions(config, 'expo-image-picker')?.microphonePermission).toBe(false);
      expect(pluginOptions(config, 'expo-secure-store')?.faceIDPermission).toBe(false);
    });

    it('does not re-add an unused usage description or permission by hand', async () => {
      const { ios, android } = (await loadConfig({ APP_ENV: 'production' })).expo;
      const handWritten = Object.keys(ios.infoPlist ?? {});
      expect(handWritten).not.toContain('NSMicrophoneUsageDescription');
      expect(handWritten).not.toContain('NSFaceIDUsageDescription');
      expect(android.permissions ?? []).not.toContain('android.permission.RECORD_AUDIO');
    });

    it('evaluates to an Info.plist with our two purpose strings and nothing else', async () => {
      const config = await loadConfig({ APP_ENV: 'production' });
      const options = pluginOptions(config, 'expo-image-picker');
      const { infoPlist } = (await evaluateNativePermissions(config)).ios;
      const usageKeys = Object.keys(infoPlist).filter((key) => key.endsWith('UsageDescription'));

      expect(usageKeys.sort()).toEqual(['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']);
      expect(infoPlist.NSCameraUsageDescription).toBe(options?.cameraPermission);
      expect(infoPlist.NSPhotoLibraryUsageDescription).toBe(options?.photosPermission);
      for (const key of usageKeys) expect(infoPlist[key]).not.toMatch(EXPO_BOILERPLATE);
    });

    it('blocks RECORD_AUDIO in the evaluated Android manifest', async () => {
      const native = await evaluateNativePermissions(await loadConfig({ APP_ENV: 'production' }));
      expect(native.android?.permissions ?? []).not.toContain('android.permission.RECORD_AUDIO');
      const { manifest } = native._internal.modResults.android.manifest;
      const recordAudio = (manifest['uses-permission'] ?? []).filter(
        (permission) => permission.$['android:name'] === 'android.permission.RECORD_AUDIO'
      );
      expect(recordAudio).toHaveLength(1);
      expect(recordAudio[0].$['tools:node']).toBe('remove');
    });
  });
});
