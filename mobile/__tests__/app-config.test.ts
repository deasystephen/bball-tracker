/**
 * app.config.js decides, at build / OTA-publish time, which API host every device
 * calls (domain migration PR3, D16). An `eas update` run with APP_ENV unset once
 * shipped apiUrl=127.0.0.1 to every device (docs/deployment/mobile-builds-and-ota.md "OTA env gotcha"); this pins
 * the mapping so that footgun is a red test, and pins the Universal Links
 * entitlement so the next native build cannot silently carry the old domain.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { APP_URL_SCHEME } from '../config/env';

import { introspectAppConfig, loadAppConfig, type IntrospectedConfig, type PublishEnv } from './helpers/app-config';

type PluginEntry = string | [string, Record<string, unknown>?];

type AndroidIntentFilter = {
  action: string;
  autoVerify?: boolean;
  data: { scheme: string; host: string; pathPattern?: string }[];
  category: string[];
};

type ExpoConfig = {
  expo: {
    version: string;
    scheme: string | string[];
    ios: { associatedDomains: string[]; infoPlist?: Record<string, unknown> };
    android: { permissions?: string[]; intentFilters: AndroidIntentFilter[] };
    plugins: PluginEntry[];
    extra: { apiUrl: string; appEnv: string };
  };
};

/** Expo's config-plugin fallbacks — what ships when no purpose string is given. */
const EXPO_BOILERPLATE = /\$\(PRODUCT_NAME\)|^Allow .* to access your/;

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
async function evaluateNativePermissions(config: ExpoConfig): Promise<IntrospectedConfig> {
  return evaluateNativeConfig(config, ['expo-image-picker', 'expo-secure-store']);
}

/** Evaluates the named plugins, with the options app.config.js gives them, in introspection mode. */
async function evaluateNativeConfig(config: ExpoConfig, names: string[]): Promise<IntrospectedConfig> {
  return introspectAppConfig(config.expo, names);
}

/** The lowest OTA runtime `version` may ever be again; history at the test that uses it. */
const RUNTIME_FLOOR = '1.7.0';

/** [major, minor, patch] compare; true when `version` >= `floor`. */
function atLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

async function loadConfig(env: PublishEnv): Promise<ExpoConfig> {
  return loadAppConfig<ExpoConfig>(env);
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

  // #721: an EAS build profile without APP_ENV would bake the dev host into
  // the binary. Every profile in eas.json sets it; this blocks a future one.
  it('EAS_BUILD=true with APP_ENV unset → throws', async () => {
    await expect(loadConfig({ EAS_BUILD: 'true' })).rejects.toThrow(/APP_ENV is unset on an EAS build/);
  });

  it('EAS_BUILD=true with APP_ENV=production → resolves', async () => {
    const cfg = await loadConfig({ EAS_BUILD: 'true', APP_ENV: 'production' });
    expect(cfg.expo.extra.apiUrl).toBe('https://api.hooplings.com');
  });

  // #721: a release bundle ignores a loopback apiUrl and calls production, so
  // a local Release build needs a way to reach a development backend.
  it('APP_ENV unset + LOCAL_API_URL → that host (a local Release build pointed at a LAN backend)', async () => {
    const cfg = await loadConfig({ LOCAL_API_URL: 'http://192.168.1.20:3000' });
    expect(cfg.expo.extra.apiUrl).toBe('http://192.168.1.20:3000');
    expect(cfg.expo.extra.appEnv).toBe('development');
  });

  it('APP_ENV unset + API_URL → still the loopback default the runtime guard catches', async () => {
    // An API_URL exported in a shell must not reach an OTA published without
    // the production environment: a LAN host would pass the runtime guard.
    const cfg = await loadConfig({ API_URL: 'http://192.168.1.20:3000' });
    expect(cfg.expo.extra.apiUrl).toBe('http://127.0.0.1:3000');
  });

  it('API_URL overrides the host in production and preview', async () => {
    expect((await loadConfig({ APP_ENV: 'production', API_URL: 'https://override.example.test' })).expo.extra.apiUrl).toBe(
      'https://override.example.test'
    );
  });

  it('Universal Links entitlement names the current apex', async () => {
    expect((await loadConfig({ APP_ENV: 'production' })).expo.ios.associatedDomains).toEqual(['applinks:hooplings.com']);
  });

  // Android App Links (#716): the manifest half of the association. Its host
  // and path are tied to the iOS side (the applinks apex and the AASA
  // component) so a domain or path change cannot move one platform and not
  // the other.
  it('Android App Links intent filter claims the same links as the iOS association', async () => {
    const { android, ios } = (await loadConfig({ APP_ENV: 'production' })).expo;
    expect(android.intentFilters).toHaveLength(1);
    const [filter] = android.intentFilters;
    expect(filter).toEqual({
      action: 'VIEW',
      autoVerify: true,
      data: [{ scheme: 'https', host: 'hooplings.com', pathPattern: '/invite/.*' }],
      category: ['BROWSABLE', 'DEFAULT'],
    });
    const iosApexes = ios.associatedDomains.map((d) => d.replace(/^applinks:/, ''));
    expect(iosApexes).toEqual([filter.data[0].host]);

    // The AASA '/invite/*' (a glob) and the manifest '/invite/.*' (Android's
    // pathPattern, where '.*' is any run of characters) name the same set.
    const aasa = JSON.parse(
      readFileSync(join(__dirname, '../../web/public/.well-known/apple-app-site-association'), 'utf8')
    ) as { applinks: { details: { components: { '/': string }[] }[] } };
    const iosPaths = aasa.applinks.details.flatMap((d) => d.components.map((c) => c['/']));
    expect(iosPaths).toEqual(['/invite/*']);
    expect(iosPaths.map((p) => p.replace(/\*$/, '.*'))).toEqual([filter.data[0].pathPattern]);
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

  // OTA runtime floor. runtimeVersion policy is appVersion, so lowering
  // `version` would send JavaScript from main to binaries that cannot run it.
  // Each boundary, newest last:
  // - 1.3.0: URL scheme rename (#504). expo-linking resolves the redirect
  //   scheme from the OTA manifest, and the 1.2.0 binaries (#25-#30) register
  //   only the old scheme.
  // - 1.4.0: dependency drift (#562). Build #31 (runtime 1.3.0) carries older
  //   native code for Amplitude, Sentry and expo-updates.
  // - 1.5.0: Expo SDK 57 (#576). Build #32 (runtime 1.4.0) is an SDK 55
  //   binary (React Native 0.83 and the SDK 55 native modules).
  // - 1.6.0: build #33 (runtime 1.5.0) still compiles lottie-react-native and
  //   expo-status-bar, has no Android App Links filter (#716, #780) and
  //   predates the binary-coupled Expo SDK 57 patch bumps.
  // - 1.7.0: build #34 (runtime 1.6.0) has no Sentry build phases or Sentry
  //   8.32 native code (#644), no CFBundleLocalizations (#671), and predates
  //   the expo 57.0.31 / expo-notifications / expo-router patches and
  //   Amplitude 1.12.
  it(`keeps the OTA runtime at or past ${RUNTIME_FLOOR}`, async () => {
    expect(atLeast((await loadConfig({ APP_ENV: 'production' })).expo.version, RUNTIME_FLOOR)).toBe(true);
  });

  // Sentry symbolication (#644). The plugin adds the Xcode phases that upload
  // the embedded bundle's maps and the dSYMs; `npm run ota:production` uploads
  // to the same org and project (sentry-symbolication.test.ts). The token must
  // never sit in the config: the plugin would write it into the native project.
  describe('Sentry Expo plugin', () => {
    it('names the Sentry org and mobile project, and no token', async () => {
      const options = pluginOptions(await loadConfig({ APP_ENV: 'production' }), '@sentry/react-native/expo');
      expect(options).toEqual({ organization: 'satsun-ventures', project: 'bball-tracker-mobile' });
    });
  });

  // Spanish declared to iOS (#671). Without CFBundleLocalizations iOS treats
  // the app as English-only (no per-app Language setting). The list must be
  // exactly the languages the app ships in i18n/locales/.
  describe('declared localizations', () => {
    const shipped = readdirSync(join(__dirname, '..', 'i18n', 'locales'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();

    it('lists every shipped language for iOS through expo-localization', async () => {
      const options = pluginOptions(await loadConfig({ APP_ENV: 'production' }), 'expo-localization');
      expect(options).toEqual({ supportedLocales: { ios: shipped } });
    });

    it('evaluates to an Info.plist with CFBundleLocalizations', async () => {
      const config = await loadConfig({ APP_ENV: 'production' });
      const { infoPlist } = (await evaluateNativeConfig(config, ['expo-localization'])).ios;
      expect(infoPlist.CFBundleLocalizations).toEqual(shipped);
    });
  });

  // Xcode 27 / iOS 27 SDK (#576). Without the scene life cycle an app built
  // with the iOS 27 SDK does not launch correctly on iOS 27, and the failure
  // only shows on a device. Baked into the binary at prebuild.
  describe('iOS scene life cycle', () => {
    it('opts in through expo-build-properties', async () => {
      const options = pluginOptions(await loadConfig({ APP_ENV: 'production' }), 'expo-build-properties');
      expect(options).toEqual({ ios: { enableSceneSupport: true } });
    });

    it('evaluates to an Info.plist that declares a scene manifest with Expo\'s scene delegate', async () => {
      const config = await loadConfig({ APP_ENV: 'production' });
      const { infoPlist } = (await evaluateNativeConfig(config, ['expo-build-properties'])).ios;

      expect(infoPlist.UIApplicationSceneManifest).toEqual({
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
            },
          ],
        },
      });
    });
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
