/**
 * Sentry symbolication guard (#644), in the spirit of the OTA drift guard.
 *
 * No mobile Sentry event was ever symbolicated: the app reported one release,
 * the build hook uploaded maps under another, bundles had no Debug IDs and no
 * OTA bundle was uploaded at all. Three pieces now carry it, and each is
 * pinned here so the next edit cannot drop one silently:
 *
 * 1. metro.config.js uses getSentryExpoConfig, which stamps a Debug ID into
 *    every bundle and map (embedded and OTA).
 * 2. `npm run ota:production` refuses to start without SENTRY_AUTH_TOKEN and
 *    its `post` script uploads what `eas update` left in dist/, to the org and
 *    project the Expo plugin names.
 * 3. The EAS build hook attaches commits to the release the events carry,
 *    named the way the native SDK names it.
 *
 * The Expo config plugin entry itself is pinned in app-config.test.ts.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadAppConfig } from './helpers/app-config';

type ReleaseParts = { bundleId: string; version: string; build: string };

/** The CommonJS build hook's exports (scripts/sentry-set-commits.js). */
const hook = jest.requireActual<{
  sentryReleaseName: (parts: ReleaseParts) => string;
  readIosReleaseParts: (iosDir: string, readPlist: (file: string) => Record<string, unknown>) => ReleaseParts | null;
  readSentryProperties: (iosDir: string) => { org: string; project: string } | null;
}>('../scripts/sentry-set-commits.js');

// The native bridge the SDK's release integration asks for the build's
// bundle id, version and build number.
const mockFetchNativeRelease = jest.fn();
jest.mock('@sentry/react-native/dist/js/wrapper', () => ({
  NATIVE: { fetchNativeRelease: () => mockFetchNativeRelease() },
}));

const MOBILE_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

type PluginEntry = string | [string, Record<string, unknown>?];

async function sentryPluginOptions(): Promise<Record<string, unknown> | undefined> {
  const config = await loadAppConfig<{ expo: { plugins: PluginEntry[] } }>({ APP_ENV: 'production' });
  const entry = config.expo.plugins.find((p) => Array.isArray(p) && p[0] === '@sentry/react-native/expo');
  return Array.isArray(entry) ? entry[1] : undefined;
}

describe('Sentry symbolication (#644)', () => {
  describe('metro.config.js', () => {
    const source = fs.readFileSync(path.join(MOBILE_ROOT, 'metro.config.js'), 'utf8');

    it('builds the config with getSentryExpoConfig from @sentry/react-native/metro', () => {
      expect(source).toMatch(/require\(['"]@sentry\/react-native\/metro['"]\)/);
      expect(source).toMatch(/getSentryExpoConfig\(projectRoot\)/);
    });

    it('no longer builds it with the plain expo/metro-config', () => {
      expect(source).not.toMatch(/require\(['"]expo\/metro-config['"]\)/);
      expect(source).not.toMatch(/getDefaultConfig\(/);
    });
  });

  describe('npm run ota:production', () => {
    it('checks the Sentry token first, then runs the drift guard and eas update', () => {
      const steps = pkg.scripts['ota:production'].split('&&').map((step) => step.trim());
      expect(steps[0]).toBe('node scripts/require-sentry-auth-token.js');
      expect(steps[1]).toBe('npm run binary-manifest:check');
      // eas update stays last, so `npm run ota:production -- --message "…"` reaches it.
      expect(steps[steps.length - 1]).toMatch(/^eas update --branch production --environment production /);
    });

    it('uploads the exported bundle and source maps after eas update (npm runs post<script>)', () => {
      const steps = pkg.scripts['postota:production'].split('&&').map((step) => step.trim());
      // The uploader exits 0 when it finds no map ("Uploaded 0 of N"), so a
      // missing map or Debug ID must fail first.
      expect(steps[0]).toBe(
        'node node_modules/@sentry/react-native/scripts/has-sourcemap-debugid.js dist/_expo/static/js/ios/*.map'
      );
      expect(steps[steps.length - 1]).toMatch(/\bsentry-expo-upload-sourcemaps dist$/);
    });

    it('uploads to the org and project the Expo plugin names, whatever the shell exports', async () => {
      const options = await sentryPluginOptions();
      const post = pkg.scripts['postota:production'];
      expect(post).toContain(`SENTRY_ORG=${String(options?.organization)} `);
      expect(post).toContain(`SENTRY_PROJECT=${String(options?.project)} `);
    });

    it('the token check fails loudly without SENTRY_AUTH_TOKEN', () => {
      const script = path.join(MOBILE_ROOT, 'scripts/require-sentry-auth-token.js');
      const run = (token: string | undefined) => {
        const env = { ...process.env };
        delete env.SENTRY_AUTH_TOKEN;
        if (token !== undefined) env.SENTRY_AUTH_TOKEN = token;
        return spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
      };
      expect(run(undefined).status).toBe(1);
      expect(run('   ').status).toBe(1);
      expect(run(' sntrys_abc\n').status).toBe(1);
      expect(run('sntrys_abc').status).toBe(0);
    });
  });

  describe('eas.json', () => {
    const eas = JSON.parse(fs.readFileSync(path.join(MOBILE_ROOT, 'eas.json'), 'utf8')) as {
      build: Record<string, { env?: Record<string, string> }>;
    };

    // The Xcode and Gradle phases fail a Release build whose upload fails,
    // and the EAS preview environment has no token.
    it('turns the build-time upload off for preview builds only', () => {
      expect(eas.build.preview.env?.SENTRY_DISABLE_AUTO_UPLOAD).toBe('true');
      expect(eas.build.production.env?.SENTRY_DISABLE_AUTO_UPLOAD).toBeUndefined();
      expect(eas.build.production.env?.SENTRY_ALLOW_FAILURE).toBeUndefined();
    });

    // A SENTRY_RELEASE here would reach extra.sentryRelease and override the
    // native release name every event must carry (services/sentry.ts).
    it('sets no SENTRY_RELEASE in any profile', () => {
      for (const profile of Object.values(eas.build)) expect(profile.env?.SENTRY_RELEASE).toBeUndefined();
    });
  });

  describe('EAS build hook (commit association)', () => {
    it('is the set-commits script, not a source map upload', () => {
      expect(pkg.scripts['eas-build-on-success']).toBe('node scripts/sentry-set-commits.js');
      const source = fs.readFileSync(path.join(MOBILE_ROOT, 'scripts/sentry-set-commits.js'), 'utf8');
      expect(source).toContain("'set-commits'");
      expect(source).not.toMatch(/'sourcemaps'/);
    });

    it('names the release the way the native SDK reports it', async () => {
      const parts = { bundleId: 'com.bballtracker.mobile', version: '1.7.0', build: '35' };
      expect(hook.sentryReleaseName(parts)).toBe('com.bballtracker.mobile@1.7.0+35');

      // What the installed SDK's release integration puts on an event when
      // Sentry.init got no release (services/sentry.ts), fed the same native
      // values: a change in the SDK's naming must change sentryReleaseName too.
      const { nativeReleaseIntegration } = jest.requireActual<{
        nativeReleaseIntegration: () => {
          processEvent: (event: Record<string, unknown>, hint: unknown, client: unknown) => Promise<Record<string, unknown>>;
        };
      }>('@sentry/react-native/dist/js/integrations/release.js');
      mockFetchNativeRelease.mockResolvedValue({ id: parts.bundleId, version: parts.version, build: parts.build });
      const event = await nativeReleaseIntegration().processEvent({}, {}, { getOptions: () => ({ release: undefined }) });
      expect(event.release).toBe(hook.sentryReleaseName(parts));
      expect(event.dist).toBe(parts.build);
    });

    it('takes the org and project from the ios/sentry.properties the plugin writes', async () => {
      const iosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-props-'));
      try {
        expect(hook.readSentryProperties(iosDir)).toBeNull();
        const options = await sentryPluginOptions();
        fs.writeFileSync(
          path.join(iosDir, 'sentry.properties'),
          `defaults.url=https://sentry.io/\ndefaults.org=${String(options?.organization)}\ndefaults.project=${String(options?.project)}\n# Using SENTRY_AUTH_TOKEN environment variable`
        );
        expect(hook.readSentryProperties(iosDir)).toEqual({ org: options?.organization, project: options?.project });
      } finally {
        fs.rmSync(iosDir, { recursive: true, force: true });
      }
    });

    describe('reads the parts from the prebuilt iOS project', () => {
      let iosDir: string;

      beforeEach(() => {
        iosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-hook-'));
        fs.mkdirSync(path.join(iosDir, 'Hooplings.xcodeproj'));
        fs.mkdirSync(path.join(iosDir, 'Hooplings'));
        fs.writeFileSync(path.join(iosDir, 'Hooplings', 'Info.plist'), '');
        fs.writeFileSync(
          path.join(iosDir, 'Hooplings.xcodeproj', 'project.pbxproj'),
          'PRODUCT_BUNDLE_IDENTIFIER = com.bballtracker.mobile;\nPRODUCT_BUNDLE_IDENTIFIER = com.bballtracker.mobile;\n'
        );
      });

      afterEach(() => fs.rmSync(iosDir, { recursive: true, force: true }));

      it('resolves $(PRODUCT_BUNDLE_IDENTIFIER) from the build settings', () => {
        const plist = {
          CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
          CFBundleShortVersionString: '1.7.0',
          CFBundleVersion: '35',
        };
        expect(hook.readIosReleaseParts(iosDir, () => plist)).toEqual({
          bundleId: 'com.bballtracker.mobile',
          version: '1.7.0',
          build: '35',
        });
      });

      it('gives up (null) rather than guess an unresolved value', () => {
        const plist = {
          CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
          CFBundleShortVersionString: '$(MARKETING_VERSION)',
          CFBundleVersion: '35',
        };
        expect(hook.readIosReleaseParts(iosDir, () => plist)).toBeNull();
        expect(hook.readIosReleaseParts(path.join(iosDir, 'missing'), () => plist)).toBeNull();
      });

      const literalPlist = {
        CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
        CFBundleShortVersionString: '1.7.0',
        CFBundleVersion: '35',
      };

      it('ignores a stray project that has no Info.plist next to it', () => {
        fs.mkdirSync(path.join(iosDir, 'Fake.xcodeproj'));
        fs.writeFileSync(path.join(iosDir, 'Fake.xcodeproj', 'project.pbxproj'), '');
        expect(hook.readIosReleaseParts(iosDir, () => literalPlist)?.bundleId).toBe('com.bballtracker.mobile');
      });

      it("picks the app's id when an extension target adds `<app id>.<suffix>`", () => {
        fs.appendFileSync(
          path.join(iosDir, 'Hooplings.xcodeproj', 'project.pbxproj'),
          'PRODUCT_BUNDLE_IDENTIFIER = "com.bballtracker.mobile.NotificationService";\n'
        );
        expect(hook.readIosReleaseParts(iosDir, () => literalPlist)?.bundleId).toBe('com.bballtracker.mobile');
        fs.appendFileSync(
          path.join(iosDir, 'Hooplings.xcodeproj', 'project.pbxproj'),
          'PRODUCT_BUNDLE_IDENTIFIER = com.example.other;\n'
        );
        expect(hook.readIosReleaseParts(iosDir, () => literalPlist)).toBeNull();
      });
    });
  });
});
