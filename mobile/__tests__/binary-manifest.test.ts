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
 * The record mode lives in this file, like a Jest snapshot update, so there is
 * exactly one implementation of "which packages count".
 */
import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '..');
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

const MANIFEST_DESCRIPTION =
  'Versions of every package with native code (and of react) in the newest binary of each OTA runtime. ' +
  'Checked by __tests__/binary-manifest.test.ts. Never edit by hand and never change an existing runtime: ' +
  'record a new one with `npm run binary-manifest:record` after the build is verified on a device (#562).';

(RECORDING ? describe : describe.skip)('binary manifest: record', () => {
  it('records the current runtime from the lockfile', () => {
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

    const next: BinaryManifest = {
      description: MANIFEST_DESCRIPTION,
      runtimes: {
        ...manifest.runtimes,
        [runtime]: {
          build,
          commit,
          recordedAt: new Date().toISOString().slice(0, 10),
          packages: packagesFromLockfile(),
        },
      },
    };
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`);

    expect(readManifest().runtimes[runtime].build).toBe(build);
  });
});

(RECORDING ? describe.skip : describe)('binary manifest (OTA drift guard)', () => {
  const runtime = currentRuntime();
  const entry: RuntimeEntry | undefined = readManifest().runtimes[runtime];

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
