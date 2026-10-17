/**
 * Evaluating app.config.js in Jest, shared by `__tests__/app-config.test.ts`
 * and the OTA drift guard (`__tests__/binary-manifest.test.ts`, #722).
 *
 * `loadAppConfig` evaluates the file fresh with an exact set of publish
 * variables; `introspectAppConfig` runs its config plugins in introspection
 * mode (what `npx expo config --type introspect` does), so no native project
 * is generated.
 *
 * Introspection reads an existing native project instead of Expo's templates
 * when one is present: Info.plist, entitlements, Podfile.properties.json,
 * AndroidManifest.xml, gradle.properties, resources. `ios/` and `android/` are
 * gitignored outputs of a local `expo run:*` / `expo prebuild`, so evaluating
 * in place made the result depend on the machine. `introspectAppConfig`
 * therefore runs against a temporary project root that links only the
 * top-level entries of mobile/ that git tracks, plus GITIGNORED_INPUTS
 * (`introspectionEntries`). That is exactly what CI's clean checkout has, by
 * construction: the next gitignored directory a plugin happens to read is
 * excluded without anyone listing it.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const MOBILE_ROOT = path.resolve(__dirname, '../..');
export const APP_CONFIG_PATH = path.join(MOBILE_ROOT, 'app.config.js');

export type PluginEntry = string | [string, unknown?];

/** The static Expo config as app.config.js returns it under `expo`. */
export interface ExpoAppConfig {
  name?: string;
  version?: string;
  extra?: unknown;
  plugins?: PluginEntry[];
  [key: string]: unknown;
}

type ManifestPermission = { $: Record<string, string> };

/** What `compileModsAsync({ introspect: true })` returns, as far as the tests read it. */
export interface IntrospectedConfig {
  ios: { infoPlist: Record<string, unknown>; entitlements?: Record<string, unknown> };
  android?: { permissions?: string[] };
  _internal: {
    modResults: {
      android: { manifest: { manifest: { 'uses-permission'?: ManifestPermission[] } } } & Record<string, unknown>;
      ios: Record<string, unknown>;
    };
  };
}

/** The subset of `expo/config-plugins` the introspection uses. */
interface ConfigPlugins {
  withPlugins: (config: Record<string, unknown>, plugins: PluginEntry[]) => Record<string, unknown>;
  compileModsAsync: (
    config: Record<string, unknown>,
    options: { projectRoot: string; introspect: boolean; platforms: ('ios' | 'android')[] }
  ) => Promise<IntrospectedConfig>;
}

/**
 * Gitignored entries that introspection still needs, each with its reason.
 * Nothing else that git ignores is linked. (`.env` is not here: no config
 * plugin in app.config.js reads it, and the hash was taken without one.)
 */
export const GITIGNORED_INPUTS: Readonly<Record<string, string>> = {
  node_modules: 'Config plugins are resolved from it, exactly as prebuild resolves them.',
};

/**
 * The top-level entries of `sourceRoot` that introspection may see: the first
 * path component of every file git tracks in mobile/ (read from the index, so
 * a scratch copy of mobile/ is judged the same way and no symlink confuses
 * it), plus GITIGNORED_INPUTS, each kept only when it exists in `sourceRoot`.
 * An untracked top-level entry is not linked until it is committed or added;
 * the files the config names are still hashed from `sourceRoot` directly.
 */
export function introspectionEntries(sourceRoot: string = MOBILE_ROOT): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: MOBILE_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed in ${MOBILE_ROOT}: ${result.stderr || result.error?.message}`);
  }
  const tracked = new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) => file.split('/')[0])
  );
  const wanted = [...tracked, ...Object.keys(GITIGNORED_INPUTS)];
  return [...new Set(wanted)].filter((entry) => fs.existsSync(path.join(sourceRoot, entry))).sort();
}

/** Symlinks each of `entries` from `sourceRoot` into `dest`. */
export function linkEntries(sourceRoot: string, dest: string, entries: readonly string[]): void {
  for (const entry of entries) fs.symlinkSync(path.join(sourceRoot, entry), path.join(dest, entry));
}

const introspectionRoots = new Map<string, string>();

/** Removes every introspection root this module instance created. */
export function removeIntrospectionRoots(): void {
  for (const dir of introspectionRoots.values()) fs.rmSync(dir, { recursive: true, force: true });
  introspectionRoots.clear();
}

// Each test file that imports this helper gets its own module instance, so
// this hook removes that file's roots (Jest sandboxes `process`, so an exit
// handler would never run). Guarded so the module can still be loaded where
// Jest's globals are absent (setupFiles, a ts-node script). The roots hold
// only symlinks: removing them never touches mobile/.
if (typeof afterAll === 'function') afterAll(removeIntrospectionRoots);

/**
 * A temporary project root that links `introspectionEntries(sourceRoot)`,
 * created once per source root and removed after the importing test file.
 * Links, not copies: node_modules resolves plugins exactly as it does in
 * place, and assets are read from the source.
 */
export function introspectionRoot(sourceRoot: string = MOBILE_ROOT): string {
  const existing = introspectionRoots.get(sourceRoot);
  if (existing) return existing;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-config-introspect-'));
  // Registered before linking, so a failure part-way still gets cleaned up.
  introspectionRoots.set(sourceRoot, root);
  linkEntries(sourceRoot, root, introspectionEntries(sourceRoot));
  return root;
}

/** Every variable app.config.js reads. */
export const PUBLISH_ENV_KEYS = [
  'APP_ENV',
  'API_URL',
  'LOCAL_API_URL',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'SENTRY_RELEASE',
  'AMPLITUDE_API_KEY',
  'EAS_BUILD',
] as const;

export type PublishEnv = Partial<Record<(typeof PUBLISH_ENV_KEYS)[number], string>>;

/** The publish variables as they are set right now. */
export function publishEnvSnapshot(): PublishEnv {
  const keys: readonly string[] = PUBLISH_ENV_KEYS;
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => keys.includes(key) && value !== undefined)
  ) as PublishEnv;
}

/**
 * Runs `run` with exactly `env` as the publish variables (unlisted ones are
 * unset) and restores them afterwards, after an async `run` has settled.
 */
export async function withEnv<T>(env: PublishEnv, run: () => T | Promise<T>): Promise<T> {
  const saved = publishEnvSnapshot();
  const apply = (values: PublishEnv): void => {
    for (const key of PUBLISH_ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  try {
    return await run();
  } finally {
    apply(saved);
  }
}

/** Evaluates app.config.js (or another copy of it) fresh, with exactly `env` set. */
export async function loadAppConfig<T = { expo: ExpoAppConfig }>(
  env: PublishEnv,
  file: string = APP_CONFIG_PATH
): Promise<T> {
  return withEnv(env, () => {
    let config: T | undefined;
    jest.isolateModules(() => {
      // CommonJS Jest: jest.requireActual evaluates the file fresh with the env above.
      const mod = jest.requireActual<{ default?: T } & T>(file);
      config = mod.default ?? mod;
    });
    if (!config) throw new Error(`${file} exports no config`);
    return config;
  });
}

/**
 * Applies the config's plugins (all of them, or only `pluginNames`, with the
 * options app.config.js gives them) and evaluates their mods in introspection
 * mode, against `introspectionRoot(sourceRoot)` so a local native project
 * never leaks in. `name` and `version` are replaced by constants and `extra` is dropped,
 * so the result does not depend on the publishing environment.
 */
export async function introspectAppConfig(
  expo: ExpoAppConfig,
  pluginNames?: readonly string[],
  sourceRoot: string = MOBILE_ROOT,
  /** false evaluates in `sourceRoot` itself; only the guard's negative control does that. */
  isolate: boolean = true
): Promise<IntrospectedConfig> {
  const projectRoot = isolate ? introspectionRoot(sourceRoot) : sourceRoot;
  const { withPlugins, compileModsAsync } = jest.requireActual<ConfigPlugins>('expo/config-plugins');
  // Introspection mutates what it is given: work on deep copies.
  const base = JSON.parse(JSON.stringify(expo)) as Record<string, unknown>;
  for (const key of ['name', 'version', 'extra', 'plugins']) delete base[key];
  const plugins = (JSON.parse(JSON.stringify(expo.plugins ?? [])) as PluginEntry[]).filter(
    (entry) => !pluginNames || pluginNames.includes(typeof entry === 'string' ? entry : entry[0])
  );
  return compileModsAsync(
    withPlugins(
      { ...base, name: 'Hooplings', version: '0.0.0', _internal: { projectRoot } },
      plugins
    ),
    { projectRoot, introspect: true, platforms: ['ios', 'android'] }
  );
}
