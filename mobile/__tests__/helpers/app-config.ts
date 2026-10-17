/**
 * Evaluating app.config.js in Jest, shared by `__tests__/app-config.test.ts`
 * and the OTA drift guard (`__tests__/binary-manifest.test.ts`, #722).
 *
 * `loadAppConfig` evaluates the file fresh with an exact set of publish
 * variables; `introspectAppConfig` runs its config plugins in introspection
 * mode (what `npx expo config --type introspect` does), so no native project
 * is generated.
 */
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
 * mode. `name` and `version` are replaced by constants and `extra` is dropped,
 * so the result does not depend on the publishing environment.
 */
export async function introspectAppConfig(
  expo: ExpoAppConfig,
  pluginNames?: readonly string[]
): Promise<IntrospectedConfig> {
  const { withPlugins, compileModsAsync } = jest.requireActual<ConfigPlugins>('expo/config-plugins');
  // Introspection mutates what it is given: work on deep copies.
  const base = JSON.parse(JSON.stringify(expo)) as Record<string, unknown>;
  for (const key of ['name', 'version', 'extra', 'plugins']) delete base[key];
  const plugins = (JSON.parse(JSON.stringify(expo.plugins ?? [])) as PluginEntry[]).filter(
    (entry) => !pluginNames || pluginNames.includes(typeof entry === 'string' ? entry : entry[0])
  );
  return compileModsAsync(
    withPlugins(
      { ...base, name: 'Hooplings', version: '0.0.0', _internal: { projectRoot: MOBILE_ROOT } },
      plugins
    ),
    { projectRoot: MOBILE_ROOT, introspect: true, platforms: ['ios', 'android'] }
  );
}
