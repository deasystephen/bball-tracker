/**
 * OTA drift guard (#562).
 *
 * `eas update` ships JavaScript from the lockfile and runs it against the
 * native code that was compiled into the binary. When a package with native
 * code moves in `package-lock.json` after the newest binary was cut, the next
 * OTA delivers JavaScript that no binary has ever run. Nothing else catches
 * that: the other suites render with `react-test-renderer`, and `expo export`
 * only proves the bundle builds.
 *
 * `binary-manifest.json` records, per OTA runtime, the version of every such
 * package in the newest binary of that runtime. This suite recomputes the set
 * from the lockfile and `node_modules` and fails on any difference.
 *
 * It fails? Read the message, then either
 *   - revert the dependency change (it has to wait for the next native build;
 *     put it on the deferred-upgrades issue), or
 *   - make it a native build: bump `version` in `app.config.js`, cut the build
 *     from the branch, verify it on a device, then record it with
 *       BINARY_BUILD=<number> BINARY_COMMIT=<sha> npm run binary-manifest:record
 *     See docs/deployment/mobile-builds-and-ota.md, "OTA drift guard (#562)".
 *
 * The same entry also records `nativeConfig` (#722): a sha256 of the native
 * configuration in `app.config.js` as compiled into that binary. A package can
 * stay put while `app.config.js` changes what prebuild bakes into the binary
 * (plugins and their options, `ios.infoPlist`, entitlements, `scheme`,
 * Android permissions, icon and splash). JavaScript that depends on such a
 * change must not reach a binary that predates it, so the same two ways out
 * apply: revert the config change, or make it a native build and record it.
 * The hash (NATIVE_CONFIG_ALGORITHM 2) covers
 *   - the whole static config except the keys in NON_NATIVE_KEYS (`name`,
 *     `version`, `extra`, `web`, each with its reason), so a key prebuild reads
 *     is covered without being listed (`plugins` and their options, `scheme`,
 *     `jsEngine`, `newArchEnabled`, `ios.*`, `android.intentFilters`, …);
 *   - the full `plugins` list evaluated in introspection mode (what
 *     `npx expo config --type introspect` prints): every `modResults` entry of
 *     both platforms (Info.plist, Expo.plist, entitlements, Podfile
 *     properties, AndroidManifest, gradle properties, resources);
 *   - the sha256 of every local file the config names (icons, splash, …).
 * Nothing in it depends on the publishing environment, so the hash is the
 * same on every machine whatever `APP_ENV`, `API_URL`, `SENTRY_DSN` or
 * `AMPLITUDE_API_KEY` say. JavaScript-only config plugins
 * (`expo-build-properties`) are not pinned by version: a plugin's code runs
 * only at prebuild and creates no JavaScript expectation, and what it
 * generates for our options is already in the introspected results.
 *
 * Runtimes recorded before #722 have no `nativeConfig`. Two one-shot paths
 * write the hash of an already-recorded runtime, and both refuse unless the
 * working tree provably has the binary's native configuration (app.config.js
 * at the recorded commit hashes identically, and every referenced file is
 * unchanged):
 *   BINARY_MANIFEST_BACKFILL_NATIVE=1 npm run binary-manifest:record
 *     adds a missing `nativeConfig`;
 *   BINARY_MANIFEST_REHASH_NATIVE=1 npm run binary-manifest:record
 *     replaces one after NATIVE_CONFIG_ALGORITHM was bumped, or after a
 *     JavaScript-only config plugin bump changed what it generates.
 *
 * The record mode lives in this file, like a Jest snapshot update, so there is
 * exactly one implementation of "which packages count" and of "what native
 * configuration counts".
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  APP_CONFIG_PATH,
  MOBILE_ROOT,
  introspectAppConfig,
  loadAppConfig,
  publishEnvSnapshot,
  withEnv,
  type ExpoAppConfig,
  type IntrospectedConfig,
} from './helpers/app-config';

const MANIFEST_PATH = path.join(MOBILE_ROOT, 'binary-manifest.json');
const LOCKFILE_PATH = path.join(MOBILE_ROOT, 'package-lock.json');

/**
 * JavaScript-only packages that are still coupled to the binary. React Native
 * bundles its own renderer, built against one React version and sharing
 * internals with `react`; it has no version guard, so a mismatch does not
 * fail loudly.
 */
const RUNTIME_COUPLED_PACKAGES = ['react'] as const;

/** Files or directories in a package root that mean "this package has native code". */
const NATIVE_DIRECTORIES = ['ios', 'android'] as const;
const EXPO_MODULE_CONFIG = 'expo-module.config.json';

type PackageVersions = Record<string, string>;

interface RuntimeEntry {
  /** Native build number of the newest binary on this runtime. */
  build: number;
  /** Commit the binary was built from. */
  commit: string;
  recordedAt: string;
  packages: PackageVersions;
  /**
   * sha256 (hex) of the native configuration in app.config.js compiled into
   * that binary (#722). Absent only on runtimes recorded before the field
   * existed, which take no further OTAs.
   */
  nativeConfig?: string;
  /** NATIVE_CONFIG_ALGORITHM the hash was computed with. */
  nativeConfigAlgorithm?: number;
}

interface BinaryManifest {
  description: string;
  runtimes: Record<string, RuntimeEntry>;
}

interface LockfilePackage {
  version?: string;
  dev?: boolean;
  link?: boolean;
}

interface Lockfile {
  packages: Record<string, LockfilePackage>;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function readManifest(): BinaryManifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { description: '', runtimes: {} };
  }
  return readJson<BinaryManifest>(MANIFEST_PATH);
}

/** `version` from app.config.js: with `runtimeVersion: { policy: 'appVersion' }` it IS the OTA runtime. */
function currentRuntime(): string {
  let version: string | undefined;
  jest.isolateModules(() => {
    const mod = jest.requireActual<{ default?: { expo: { version: string } }; expo?: { version: string } }>(
      '../app.config.js'
    );
    version = (mod.default ?? mod).expo?.version;
  });
  if (!version) throw new Error('app.config.js has no expo.version');
  return version;
}

/* ---------- native configuration (#722) ---------- */

/**
 * Version of what `nativeConfigInput()` hashes. Bump it whenever that changes:
 * every recorded hash then fails with a pointer to the re-record path.
 *   1: allow-list of static fields + Info.plist, entitlements, uses-permission
 *      (first #722 cut, superseded in review).
 *   2: the whole static config minus NON_NATIVE_KEYS, the full introspected
 *      `modResults` of both platforms, and every referenced local file.
 */
const NATIVE_CONFIG_ALGORITHM = 2;

/**
 * Top-level static config keys left out of the hash, and why. Everything else
 * is hashed, so a key prebuild reads (`jsEngine`, `newArchEnabled`,
 * `android.intentFilters`, `locales`, `notification`, `ios.privacyManifests`,
 * …) is covered without being listed.
 */
const NON_NATIVE_KEYS: Record<string, string> = {
  name:
    'Depends on APP_ENV (`Hooplings (dev)` outside production); a display-name change is cosmetic and creates no JavaScript expectation.',
  version: 'The OTA runtime itself (runtimeVersion policy appVersion): a change is a new runtime, never drift.',
  extra: 'The OTA manifest payload, read by JavaScript and set per publish (API host, Sentry, Amplitude).',
  web: 'Used only by the web export; never reaches the iOS or Android binary.',
};

/** A string in the config that names a file under mobile/ (icons, splash, google services, …). */
const LOCAL_FILE = /^\.{1,2}\//;

/** JSON with object keys sorted at every level; arrays keep their order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** The static config with NON_NATIVE_KEYS removed, as plain JSON. */
function nativeStaticConfig(expo: ExpoAppConfig): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(expo)) as Record<string, unknown>;
  for (const key of Object.keys(NON_NATIVE_KEYS)) delete copy[key];
  return copy;
}

/** Every local file the hashed config names, relative to mobile/, sorted. */
function referencedFiles(value: unknown, found: Set<string> = new Set()): string[] {
  if (typeof value === 'string' && LOCAL_FILE.test(value)) found.add(path.normalize(value));
  else if (Array.isArray(value)) value.forEach((item) => referencedFiles(item, found));
  else if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => referencedFiles(item, found));
  }
  return [...found].sort();
}

/** Evaluates an app.config.js the way a production build does: APP_ENV forced to `production`. */
async function loadExpoConfig(file: string): Promise<ExpoAppConfig> {
  return (await loadAppConfig({ ...publishEnvSnapshot(), APP_ENV: 'production' }, file)).expo;
}

/** The structure the hash is taken over; see the file header. */
async function nativeConfigInput(expo: ExpoAppConfig): Promise<Record<string, unknown>> {
  let introspected: IntrospectedConfig;
  try {
    introspected = await introspectAppConfig(expo);
  } catch (error) {
    // Typically a plugin that is not installed. Prebuild would fail the same
    // way, and a new plugin is a native change either way.
    throw new Error(
      `The config plugins in app.config.js cannot be evaluated (${error instanceof Error ? error.message : String(error)}). ` +
        'A plugin added or changed in app.config.js is native configuration: it ships only with a native build ' +
        '(bump `version`, cut and verify the build, then record it with npm run binary-manifest:record), or revert it.'
    );
  }

  const staticConfig = nativeStaticConfig(expo);
  const files = Object.fromEntries(
    referencedFiles(staticConfig).map((file) => {
      const absolute = path.join(MOBILE_ROOT, file);
      return [file, fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? sha256(fs.readFileSync(absolute)) : 'missing'];
    })
  );

  return {
    algorithm: NATIVE_CONFIG_ALGORITHM,
    static: staticConfig,
    modResults: introspected._internal.modResults,
    files,
  };
}

const hashMemo = new Map<string, Promise<string>>();

/**
 * sha256 of the native configuration of an app.config.js (default: the
 * working tree's). Memoised per file and publish-env snapshot: introspection
 * is the slow part of this suite.
 */
function nativeConfigHash(file: string = APP_CONFIG_PATH): Promise<string> {
  const key = `${file}\0${stableStringify(publishEnvSnapshot())}`;
  let hash = hashMemo.get(key);
  if (!hash) {
    hash = loadExpoConfig(file).then(async (expo) => sha256(stableStringify(await nativeConfigInput(expo))));
    hashMemo.set(key, hash);
  }
  return hash;
}

function git(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: MOBILE_ROOT, encoding: 'utf8', stdio: 'pipe' }).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Safety check for the backfill and re-hash paths: the working tree's native
 * configuration must be the one the binary was built from. Passes when
 * app.config.js and every referenced file are byte-identical to `commit`, or
 * when app.config.js differs only in text that does not reach the native
 * config (its version at `commit`, hashed now with the current algorithm and
 * node_modules, equals the working tree's hash). When `commit` is not in the
 * local clone, falls back to history: the last commit touching app.config.js
 * or those files must predate the day the runtime was recorded. Returns the
 * reason it refused, or null.
 */
async function nativeConfigRefusal(entry: RuntimeEntry, current: string): Promise<string | null> {
  const files = referencedFiles(nativeStaticConfig(await loadExpoConfig(APP_CONFIG_PATH)));
  const watched = ['app.config.js', ...files];

  if (!git(['cat-file', '-e', `${entry.commit}^{commit}`]).ok) {
    const last = git(['log', '-1', '--format=%h %cs', '--', ...watched]).out;
    const [sha, day] = last.split(' ');
    if (!day || day >= entry.recordedAt) {
      return (
        `commit ${entry.commit} is not in this clone (git fetch it), and the last change to ` +
        `${watched.join(', ')} (${last || 'none found'}) does not predate the record day ${entry.recordedAt}.`
      );
    }
    if (!git(['diff', '--quiet', 'HEAD', '--', ...watched]).ok) {
      return `${watched.join(', ')} has uncommitted changes since ${sha}.`;
    }
    return null;
  }

  if (!git(['diff', '--quiet', entry.commit, '--', ...files]).ok) {
    return `a referenced file (${files.join(', ')}) differs from commit ${entry.commit}.`;
  }
  if (git(['diff', '--quiet', entry.commit, '--', 'app.config.js']).ok) return null;

  const source = git(['show', `${entry.commit}:./app.config.js`]);
  if (!source.ok) return `could not read app.config.js at ${entry.commit}.`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-manifest-'));
  try {
    const recordedFile = path.join(dir, 'app.config.js');
    fs.writeFileSync(recordedFile, `${source.out}\n`);
    const recorded = await nativeConfigHash(recordedFile);
    return recorded === current
      ? null
      : `the native configuration of app.config.js differs from commit ${entry.commit} ` +
          `(hash there ${recorded}, working tree ${current}).`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hasNativeCode(packageDir: string): boolean {
  const entries = fs.readdirSync(packageDir);
  return (
    NATIVE_DIRECTORIES.some((dir) => entries.includes(dir)) ||
    entries.includes(EXPO_MODULE_CONFIG) ||
    entries.some((entry) => entry.endsWith('.podspec'))
  );
}

/** `node_modules/a/node_modules/b` -> `a/node_modules/b`; a top-level package is just its name. */
function packageKey(lockfilePath: string): string {
  return lockfilePath.replace(/^node_modules\//, '');
}

/**
 * Every production package that ships native code, plus the runtime-coupled
 * ones, at the version the LOCKFILE pins. Dev-only packages never reach the
 * binary and are skipped.
 */
function packagesFromLockfile(): PackageVersions {
  const lockfile = readJson<Lockfile>(LOCKFILE_PATH);
  const found: PackageVersions = {};

  for (const [lockfilePath, meta] of Object.entries(lockfile.packages)) {
    if (!lockfilePath.startsWith('node_modules/')) continue;
    if (meta.dev || meta.link || !meta.version) continue;

    const key = packageKey(lockfilePath);
    const coupled = (RUNTIME_COUPLED_PACKAGES as readonly string[]).includes(key);
    const packageDir = path.join(MOBILE_ROOT, lockfilePath);
    if (!coupled && !(fs.existsSync(packageDir) && hasNativeCode(packageDir))) continue;

    found[key] = meta.version;
  }

  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

function installedVersion(key: string): string | null {
  const file = path.join(MOBILE_ROOT, 'node_modules', key, 'package.json');
  return fs.existsSync(file) ? readJson<{ version: string }>(file).version : null;
}

interface Drift {
  changed: string[];
  added: string[];
  removed: string[];
}

function diff(recorded: PackageVersions, current: PackageVersions): Drift {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, version] of Object.entries(current)) {
    if (!(name in recorded)) added.push(`${name}@${version}`);
    else if (recorded[name] !== version) changed.push(`${name}: binary has ${recorded[name]}, lockfile has ${version}`);
  }
  for (const name of Object.keys(recorded)) {
    if (!(name in current)) removed.push(`${name}@${recorded[name]}`);
  }
  return { changed, added, removed };
}

const RECORDING = process.env.RECORD_BINARY_MANIFEST === '1';
const BACKFILLING_NATIVE = process.env.BINARY_MANIFEST_BACKFILL_NATIVE === '1';
const REHASHING_NATIVE = process.env.BINARY_MANIFEST_REHASH_NATIVE === '1';
const UPDATING_NATIVE = BACKFILLING_NATIVE || REHASHING_NATIVE;

const MANIFEST_DESCRIPTION =
  'Versions of every package with native code (and of react) in the newest binary of each OTA runtime, ' +
  'and `nativeConfig`, a sha256 of the native configuration in app.config.js compiled into it (#722). ' +
  'Checked by __tests__/binary-manifest.test.ts. Never edit by hand and never change an existing runtime: ' +
  'record a new one with `npm run binary-manifest:record` after the build is verified on a device (#562).';

const REHASH_COMMAND = 'BINARY_MANIFEST_REHASH_NATIVE=1 npm run binary-manifest:record';

function writeManifest(manifest: BinaryManifest): void {
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify({ ...manifest, description: MANIFEST_DESCRIPTION }, null, 2)}\n`);
}

(RECORDING && UPDATING_NATIVE ? describe : describe.skip)('binary manifest: backfill or re-hash nativeConfig', () => {
  it('writes the native-config hash of the current runtime when the binary provably has that config', async () => {
    if (BACKFILLING_NATIVE && REHASHING_NATIVE) {
      throw new Error('Set BINARY_MANIFEST_BACKFILL_NATIVE or BINARY_MANIFEST_REHASH_NATIVE, not both.');
    }
    const mode = BACKFILLING_NATIVE ? 'backfill' : 're-hash';
    const runtime = currentRuntime();
    const manifest = readManifest();
    const entry = manifest.runtimes[runtime];
    if (!entry) throw new Error(`Runtime ${runtime} has no recorded binary; record it with BINARY_BUILD/BINARY_COMMIT.`);

    if (BACKFILLING_NATIVE && entry.nativeConfig) {
      throw new Error(
        `Runtime ${runtime} already records nativeConfig. A runtime is immutable: the backfill only adds a missing field ` +
          `(when the hash algorithm or a config plugin's output changed, use ${REHASH_COMMAND}).`
      );
    }
    if (REHASHING_NATIVE && !entry.nativeConfig) {
      throw new Error(`Runtime ${runtime} has no nativeConfig to re-hash; use BINARY_MANIFEST_BACKFILL_NATIVE=1.`);
    }

    const nativeConfig = await nativeConfigHash();
    if (
      REHASHING_NATIVE &&
      entry.nativeConfig === nativeConfig &&
      entry.nativeConfigAlgorithm === NATIVE_CONFIG_ALGORITHM
    ) {
      throw new Error(`Runtime ${runtime} already records this hash under algorithm ${NATIVE_CONFIG_ALGORITHM}; nothing to re-hash.`);
    }

    const refusal = await nativeConfigRefusal(entry, nativeConfig);
    if (refusal) {
      throw new Error(
        `Refusing to ${mode} nativeConfig for runtime ${runtime} (build #${entry.build}): ${refusal} ` +
          'The working tree would not describe the binary in the field. Revert the native change, or cut and record a new runtime.'
      );
    }

    writeManifest({
      ...manifest,
      runtimes: {
        ...manifest.runtimes,
        [runtime]: { ...entry, nativeConfig, nativeConfigAlgorithm: NATIVE_CONFIG_ALGORITHM },
      },
    });

    expect(readManifest().runtimes[runtime].nativeConfig).toBe(nativeConfig);
  });
});

(RECORDING && !UPDATING_NATIVE ? describe : describe.skip)('binary manifest: record', () => {
  it('records the current runtime from the lockfile and app.config.js', async () => {
    const runtime = currentRuntime();
    const manifest = readManifest();

    const build = Number(process.env.BINARY_BUILD);
    const commit = process.env.BINARY_COMMIT ?? '';
    if (!Number.isInteger(build) || build <= 0) {
      throw new Error('Set BINARY_BUILD to the native build number of the verified binary.');
    }
    if (!/^[0-9a-f]{7,40}$/.test(commit)) {
      throw new Error('Set BINARY_COMMIT to the commit the verified binary was built from.');
    }
    if (manifest.runtimes[runtime]) {
      throw new Error(
        `Runtime ${runtime} is already recorded (build #${manifest.runtimes[runtime].build}). ` +
          'A runtime is immutable: binaries already in the field were compiled with those versions. ' +
          'Bump `version` in app.config.js so the new build gets its own runtime.'
      );
    }

    writeManifest({
      description: MANIFEST_DESCRIPTION,
      runtimes: {
        ...manifest.runtimes,
        [runtime]: {
          build,
          commit,
          recordedAt: new Date().toISOString().slice(0, 10),
          packages: packagesFromLockfile(),
          nativeConfig: await nativeConfigHash(),
          nativeConfigAlgorithm: NATIVE_CONFIG_ALGORITHM,
        },
      },
    });

    expect(readManifest().runtimes[runtime].build).toBe(build);
  });
});

(RECORDING ? describe.skip : describe)('binary manifest (OTA drift guard)', () => {
  const runtime = currentRuntime();
  const entry: RuntimeEntry | undefined = readManifest().runtimes[runtime];
  let currentHash = '';

  beforeAll(async () => {
    currentHash = await nativeConfigHash();
  });

  it('has a recorded binary for the current OTA runtime', () => {
    // Fails right after `version` is bumped, until the build cut from that
    // branch is verified and recorded. That is the point: an OTA must never
    // be published to a runtime that has no binary.
    expect(Object.keys(readManifest().runtimes)).toContain(runtime);
    expect(entry?.build).toBeGreaterThan(0);
    expect(entry?.commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('pins every package with native code to the version compiled into that binary', () => {
    const drift = diff(entry?.packages ?? {}, packagesFromLockfile());

    // One assertion on the whole object, so the failure lists every package.
    expect(drift).toEqual({ changed: [], added: [], removed: [] });
  });

  it('matches the native configuration compiled into that binary', () => {
    // Only the current runtime is checked: older runtimes (1.4.0) were
    // recorded before #722 and take no further OTAs.
    if (!entry?.nativeConfig) {
      throw new Error(
        `Runtime ${runtime} has no nativeConfig hash recorded, so nothing proves app.config.js still matches the ` +
          'binary. Record it with the build (BINARY_BUILD=<number> BINARY_COMMIT=<sha> npm run binary-manifest:record), ' +
          'or, for a runtime recorded before #722 whose app.config.js is unchanged since its commit, once with ' +
          'BINARY_MANIFEST_BACKFILL_NATIVE=1 npm run binary-manifest:record.'
      );
    }
    if (entry.nativeConfigAlgorithm !== NATIVE_CONFIG_ALGORITHM) {
      throw new Error(
        `Runtime ${runtime} records a nativeConfig hash made with algorithm ${entry.nativeConfigAlgorithm ?? 1}; ` +
          `this guard hashes with algorithm ${NATIVE_CONFIG_ALGORITHM}. Re-record it with ${REHASH_COMMAND}, which ` +
          `refuses unless app.config.js at commit ${entry.commit} hashes identically to the working tree.`
      );
    }
    if (entry.nativeConfig === currentHash) return;

    throw new Error(
      `The native configuration in app.config.js no longer matches build #${entry.build} (runtime ${runtime}, ` +
        `commit ${entry.commit}): a plugin or its options, ios/android config (infoPlist, entitlements, ` +
        'associatedDomains, intentFilters, permissions, …), scheme, an engine flag or a referenced icon/splash file ' +
        "changed. Prebuild bakes these into the binary, so an OTA cannot deliver them. Either\n" +
        '  - revert the change (it waits for the next native build), or\n' +
        '  - make it a native build: bump `version` in app.config.js, cut the build from the branch, verify it on ' +
        'a device, then record it with BINARY_BUILD=<number> BINARY_COMMIT=<sha> npm run binary-manifest:record.\n' +
        `See what moved: git diff ${entry.commit} -- mobile/app.config.js mobile/assets\n` +
        'If neither app.config.js nor the assets changed natively (for example a JavaScript-only config plugin bump ' +
        `changed what it generates), re-record with ${REHASH_COMMAND}; it refuses when app.config.js at ` +
        `${entry.commit} hashes differently from the working tree.\n` +
        `recorded ${entry.nativeConfig}\ncurrent  ${currentHash}`
    );
  });

  it('hashes the native configuration the same whatever the publishing environment says', async () => {
    const unset = await withEnv({}, () => nativeConfigHash());
    const set = await withEnv(
      {
        APP_ENV: 'preview',
        API_URL: 'https://override.example.test',
        LOCAL_API_URL: 'http://192.168.1.20:3000',
        SENTRY_DSN: 'https://key@o0.ingest.example.test/1',
        SENTRY_ENVIRONMENT: 'preview',
        SENTRY_RELEASE: 'release-x',
        AMPLITUDE_API_KEY: 'amplitude-key',
        EAS_BUILD: 'true',
      },
      () => nativeConfigHash()
    );
    expect(set).toBe(unset);
    expect(unset).toBe(currentHash);
    expect(unset).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covers the packages this guard was written for', () => {
    // If the scan ever stops finding these, it is the scan that broke.
    const names = Object.keys(entry?.packages ?? {});
    expect(names).toEqual(
      expect.arrayContaining([
        '@amplitude/analytics-react-native',
        '@sentry/react-native',
        'expo',
        'expo-modules-core',
        'expo-updates',
        'react',
        'react-native',
      ])
    );
  });

  it('runs against node_modules that match the lockfile', () => {
    // `eas update` bundles what is INSTALLED. A stale node_modules would ship
    // other versions than the lockfile says; run `npm ci` before publishing.
    const stale = Object.entries(packagesFromLockfile())
      .map(([name, version]) => ({ name, lockfile: version, installed: installedVersion(name) }))
      .filter(({ lockfile, installed }) => installed !== lockfile);

    expect(stale).toEqual([]);
  });
});
