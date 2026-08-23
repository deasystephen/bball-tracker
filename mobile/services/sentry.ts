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

/** Query keys whose values are masked in URLs (exact, lower-cased). */
const SENSITIVE_QUERY_KEYS = ['code', 'token', 'state', 'password', 'otp', 'jwt'];
/** Substrings that make any query key sensitive. */
const SENSITIVE_QUERY_SUBSTRINGS = ['token', 'secret', 'password', 'authorization', 'api_key', 'apikey'];
/** Path segments whose *following* segment is a bearer secret. */
const SECRET_PATH_PARENTS = ['by-token', 'calendar', 'invite'];
const NON_SECRET_SUBRESOURCES = ['subscribe', 'revoke', 'accept'];

function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.includes(lower)) return true;
  return SENSITIVE_QUERY_SUBSTRINGS.some(s => lower.includes(s));
}

function redactQueryString(qs: string): string {
  if (!qs) return '';
  return qs
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      let decodedKey = key;
      try {
        decodedKey = decodeURIComponent(key);
      } catch {
        // keep raw key
      }
      return isSensitiveQueryKey(decodedKey) ? `${key}=${SCRUBBED}` : pair;
    })
    .join('&');
}

function redactPath(path: string): string {
  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (SECRET_PATH_PARENTS.includes(segments[i])) {
      const next = segments[i + 1];
      if (next && next.length > 8 && !NON_SECRET_SUBRESOURCES.includes(next)) {
        segments[i + 1] = SCRUBBED;
      }
    }
  }
  return segments.join('/');
}

/**
 * Redact a URL *by value*, not by key name: OAuth `?code=`/`?state=`,
 * `?token=` query values and `/by-token/<x>`, `/calendar/<x>`, `/invite/<x>`
 * path segments are masked. XHR breadcrumbs carry the URL under `data.url`,
 * which a key-name scrub alone never touches (audit #15). Exported for tests.
 */
export function redactUrl(url: string): string {
  if (!url) return url;
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  const base = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
  const qs = qIdx === -1 ? '' : noHash.slice(qIdx + 1);

  const schemeMatch = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i);
  const prefix = schemeMatch ? schemeMatch[1] : '';
  const path = schemeMatch ? schemeMatch[2] ?? '' : base;

  const redactedPath = prefix + redactPath(path);
  const redactedQs = redactQueryString(qs);
  return redactedQs ? `${redactedPath}?${redactedQs}` : redactedPath;
}

/** Keys in breadcrumb/extra data that hold URLs and need value-level redaction. */
const URL_DATA_KEYS = ['url', 'http.url', 'http.target', 'url.full', 'from', 'to'];

function scrubDataBag<T>(data: T): T {
  const out = scrub(data) as Record<string, unknown>;
  for (const key of URL_DATA_KEYS) {
    if (typeof out[key] === 'string') out[key] = redactUrl(out[key] as string);
  }
  return out as T;
}

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
    if (typeof event.request.url === 'string') event.request.url = redactUrl(event.request.url);
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = redactQueryString(event.request.query_string);
    }
    if ('data' in event.request) event.request.data = SCRUBBED;
  }
  if (event.extra) event.extra = scrub(event.extra);
  if (event.contexts) event.contexts = scrub(event.contexts);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(b => ({
      ...b,
      data: b.data ? scrubDataBag(b.data) : b.data,
    }));
  }
  if (typeof event.transaction === 'string') event.transaction = redactUrl(event.transaction);
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
      // Transactions bypass beforeSend; same URL redaction applies (audit #15).
      beforeSendTransaction: event => beforeSend(event as Sentry.Event) as typeof event,
    });
    initialized = true;
  } catch (error) {
    if (__DEV__) {
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

/**
 * Report a caught exception to Sentry.
 *
 * No-op until init has run (dev, or production without a DSN wired), so callers
 * can wire it into catch blocks unconditionally. Optional `context` is attached
 * as event contexts and runs through `beforeSend` scrubbing like any other event.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>
): void {
  if (!initialized) return;
  try {
    Sentry.captureException(
      error,
      context ? { contexts: { app: context } } : undefined
    );
  } catch {
    // swallow — error reporting must never throw into the caller's catch block
  }
}

export function isSentryEnabled(): boolean {
  return initialized;
}
