/**
 * What is running on this device, for the API and for diagnostics (#963):
 * the binary's version, the OTA update (if any) and the runtime version, plus
 * the two request headers the api-client sends on every call.
 *
 * - `X-Hooplings-Client: ios/<version>+<update id | embedded>` (or
 *   `android/…`) lets the API's `HTTP request` log line say which app build
 *   made the request, so Datadog can split errors by version and OTA.
 * - `X-Request-Id: <uuid v4>`, fresh per request. The API uses a valid id
 *   verbatim as `requestId` on its log lines and echoes it on the response;
 *   the api-client tags its Sentry captures and `http` breadcrumbs with the
 *   same value (`request_id`), so a mobile event leads to the exact API line.
 *
 * The contract the API validates (`docs/architecture/backend-services.md`):
 * `<platform>/<version>` with 1–4 dot-separated numeric parts, an optional
 * `+<build>` matching `[A-Za-z0-9._-]{1,40}`, 64 characters at most. A value
 * the API cannot parse is dropped there, so this module sends nothing rather
 * than something the API would discard.
 *
 * Read through `requireOptionalNativeModule('ExpoUpdates')`, never the
 * `expo-updates` JS wrapper: the wrapper throws at import when its native
 * module is missing, and this module is loaded by the api-client on every
 * launch. Every binary has the module today; the guard keeps an OTA from
 * ever crashing one that does not.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import { uuid } from 'expo-modules-core';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const CLIENT_HEADER = 'X-Hooplings-Client';

/** The native constants `expo-updates` itself reads (`ExpoUpdates.ts`). */
interface ExpoUpdatesConstants {
  isEnabled?: boolean;
  isEmbeddedLaunch?: boolean;
  updateId?: string | null;
  runtimeVersion?: string | null;
}

export interface RunningBuild {
  /** `expoConfig.version`: the binary's version (an OTA on the same runtime keeps it). */
  appVersion: string;
  /** `update` when an OTA is running, `embedded` when the binary's bundled JS is. */
  launch: 'embedded' | 'update';
  /** The running OTA's id (lower-case UUID), or null for an embedded launch. */
  updateId: string | null;
  /** The runtime version the binary was built for; falls back to `appVersion` (policy `appVersion`). */
  runtimeVersion: string;
}

/**
 * Snapshot of the running build. Mirrors the About screen's reading
 * (`app/about.tsx#getAboutInfo`): with updates disabled (a dev client), or no
 * update id, the bundled JS is running. Never throws.
 */
export function getRunningBuild(): RunningBuild {
  let updates: ExpoUpdatesConstants | null = null;
  try {
    updates = requireOptionalNativeModule<ExpoUpdatesConstants>('ExpoUpdates');
  } catch {
    updates = null;
  }
  const appVersion = Constants.expoConfig?.version ?? 'unknown';
  const rawId = typeof updates?.updateId === 'string' && updates.updateId ? updates.updateId.toLowerCase() : null;
  const embedded = !updates?.isEnabled || !!updates?.isEmbeddedLaunch || !rawId;
  const runtime = typeof updates?.runtimeVersion === 'string' && updates.runtimeVersion ? updates.runtimeVersion : null;
  return {
    appVersion,
    launch: embedded ? 'embedded' : 'update',
    updateId: embedded ? null : rawId,
    runtimeVersion: runtime ?? appVersion,
  };
}

const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;
const BUILD_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
const CLIENT_MAX_LENGTH = 64;

/**
 * The `X-Hooplings-Client` value, e.g. `ios/1.6.0+01a15220-8b6d-7172-a9a5-2d5fce7c6954`
 * or `ios/1.6.0+embedded`; null (header not sent) on a platform other than
 * iOS or Android or a version the API would not accept.
 */
export function clientHeaderValue(build: RunningBuild = getRunningBuild()): string | null {
  const platform = Platform.OS;
  if (platform !== 'ios' && platform !== 'android') return null;
  if (!VERSION_PATTERN.test(build.appVersion)) return null;
  const suffix = build.updateId ?? 'embedded';
  const value = BUILD_PATTERN.test(suffix)
    ? `${platform}/${build.appVersion}+${suffix}`
    : `${platform}/${build.appVersion}`;
  return value.length <= CLIENT_MAX_LENGTH ? value : null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A UUID v4 for `X-Request-Id`. expo-modules-core's native generator (the one
 * `utils/pkce.ts` uses, in every binary) when it is there; otherwise
 * `Math.random`. A request id only has to be unique enough to find one log
 * line, not unguessable, so the fallback is fine and the header is never
 * skipped for want of a generator.
 */
export function newRequestId(): string {
  try {
    const id = uuid.v4();
    if (typeof id === 'string' && UUID_V4.test(id)) return id.toLowerCase();
  } catch {
    // Native generator unavailable (Jest, or a binary without it): fall through.
  }
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
