/**
 * Sentry initialization for the mobile app.
 *
 * Init is gated on `sentryDsn` being present in Expo config extras (populated
 * from `SENTRY_DSN` in the EAS build env). Dev builds without a DSN no-op so
 * local dev doesn't ship events.
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

let initialized = false;

const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'secret',
  'jwt',
  'session',
  'x-api-key',
  'x-auth-token',
  'email',
  'otp',
];

const SCRUBBED = '[scrubbed]';

function scrub<T>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return (input as unknown[]).map(v =>
      v && typeof v === 'object' ? scrub(v) : v
    ) as unknown as T;
  }
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some(k => lower.includes(k))) {
      out[key] = SCRUBBED;
      continue;
    }
    const val = out[key];
    if (val && typeof val === 'object') {
      out[key] = scrub(val);
    }
  }
  return out as T;
}

/**
 * Exported for tests.
 */
export function beforeSend(event: Sentry.Event): Sentry.Event {
  if (event.request) {
    if (event.request.headers) event.request.headers = scrub(event.request.headers);
    if (event.request.cookies) event.request.cookies = scrub(event.request.cookies);
    if ('data' in event.request) event.request.data = SCRUBBED;
  }
  if (event.extra) event.extra = scrub(event.extra);
  if (event.contexts) event.contexts = scrub(event.contexts);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(b => ({
      ...b,
      data: b.data ? scrub(b.data) : b.data,
    }));
  }
  return event;
}

/**
 * Initialize Sentry. Safe to call multiple times.
 * No-op when the DSN is not configured (dev, or production without env wired).
 */
export function initSentry(): void {
  if (initialized) return;

  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const dsn = (extra?.sentryDsn as string | undefined) || process.env.SENTRY_DSN;
  if (!dsn) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[Sentry] No DSN configured, skipping initialization');
    }
    return;
  }

  const environment =
    (extra?.sentryEnvironment as string | undefined) ||
    process.env.SENTRY_ENVIRONMENT ||
    (extra?.appEnv as string | undefined) ||
    (__DEV__ ? 'development' : 'production');

  // Release identifier: EAS build id → version-buildNumber → undefined.
  const release =
    (extra?.sentryRelease as string | undefined) ||
    process.env.SENTRY_RELEASE ||
    buildReleaseFromConstants();

  try {
    Sentry.init({
      dsn,
      environment,
      release,
      enableAutoSessionTracking: true,
      sendDefaultPii: false,
      tracesSampleRate: 0.1,
      beforeSend: event => beforeSend(event) as typeof event,
    });
    initialized = true;
  } catch (error) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[Sentry] Failed to initialize:', error);
    }
  }
}

function buildReleaseFromConstants(): string | undefined {
  const cfg = Constants.expoConfig as { version?: string } | undefined;
  const version = cfg?.version;
  // expo-constants exposes easBuildId via runtime
  const easBuildId = (Constants as unknown as { easConfig?: { buildId?: string } }).easConfig?.buildId;
  if (easBuildId) return `${version || 'unknown'}+${easBuildId}`;
  return version;
}

/**
 * Identify the current user for Sentry events.
 */
export function setSentryUser(userId: string | null): void {
  if (!initialized) return;
  try {
    if (userId) {
      Sentry.setUser({ id: userId });
    } else {
      Sentry.setUser(null);
    }
  } catch {
    // swallow
  }
}

export function isSentryEnabled(): boolean {
  return initialized;
}
