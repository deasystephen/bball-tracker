/**
 * URL / query-string redaction shared by the request logger and the Sentry
 * hooks (audit #15).
 *
 * Secrets travel in two places on this API:
 *   - query params: `?code=` / `?state=` on the OAuth callback, `?token=` on
 *     the public calendar feed;
 *   - path segments: `/invitations/by-token/<token>`, `/calendar/<token>`,
 *     `/invite/<token>` (web accept page).
 *
 * Everything here is pure string/object manipulation so it can be unit-tested
 * and reused without touching Express or Sentry.
 */

export const REDACTED = '[redacted]';

/** Exact query keys whose values are always masked. */
const SENSITIVE_QUERY_KEYS = new Set(['code', 'token', 'state', 'password', 'otp', 'jwt']);

/** Substrings that make any query key sensitive (case-insensitive). */
const SENSITIVE_QUERY_SUBSTRINGS = ['token', 'secret', 'password', 'authorization', 'api_key', 'apikey'];

/**
 * Path segments whose *following* segment is a bearer secret and must be masked.
 */
const SECRET_PATH_PARENTS = new Set(['by-token', 'calendar', 'invite']);

export function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.has(lower)) return true;
  return SENSITIVE_QUERY_SUBSTRINGS.some(s => lower.includes(s));
}

/**
 * Redact a parsed query object: keys are kept, sensitive values masked.
 * Non-sensitive values are left as-is (nested objects/arrays walked).
 */
export function redactQueryObject<T extends Record<string, unknown>>(query: T | undefined): T | undefined {
  if (!query || typeof query !== 'object') return query;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (isSensitiveQueryKey(key)) {
      out[key] = REDACTED;
    } else if (Array.isArray(value)) {
      out[key] = value.map(v => (v && typeof v === 'object' ? redactQueryObject(v as Record<string, unknown>) : v));
    } else if (value && typeof value === 'object') {
      out[key] = redactQueryObject(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Redact a raw query string (`a=1&code=abc`). Keys are preserved so logs stay
 * greppable; sensitive values become `[redacted]`. A leading `?` is tolerated
 * and stripped.
 */
export function redactQueryString(qs: string | undefined | null): string {
  if (!qs) return '';
  const raw = qs.startsWith('?') ? qs.slice(1) : qs;
  if (!raw) return '';
  return raw
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (eq === -1) return key;
      let decodedKey = key;
      try {
        decodedKey = decodeURIComponent(key);
      } catch {
        // keep the raw key
      }
      return isSensitiveQueryKey(decodedKey) ? `${key}=${REDACTED}` : pair;
    })
    .join('&');
}

/**
 * Mask secret path segments: the segment after `by-token`, `calendar` or
 * `invite` is replaced with `[redacted]`. Segments that are themselves a known
 * sub-resource (e.g. `/calendar/subscribe`) are left alone because they are
 * not secrets — only opaque tokens (no dots, length > 8) are masked.
 */
export function redactPath(path: string | undefined | null): string {
  if (!path) return '';
  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (SECRET_PATH_PARENTS.has(segments[i])) {
      const next = segments[i + 1];
      if (looksLikeToken(next)) segments[i + 1] = REDACTED;
    }
  }
  return segments.join('/');
}

function looksLikeToken(segment: string): boolean {
  if (!segment) return false;
  // Known literal sub-resources under /calendar and /invite are never tokens.
  if (['subscribe', 'revoke', 'accept'].includes(segment)) return false;
  return segment.length > 8;
}

/**
 * Redact a full URL (absolute or path-only): secret path segments masked,
 * query values masked, fragment dropped.
 */
export function redactUrl(url: string | undefined | null): string {
  if (!url) return '';
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  const base = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
  const qs = qIdx === -1 ? '' : noHash.slice(qIdx + 1);

  // Split scheme+host from path for absolute URLs so redactPath only sees the path.
  const schemeMatch = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i);
  const prefix = schemeMatch ? schemeMatch[1] : '';
  const path = schemeMatch ? schemeMatch[2] ?? '' : base;

  const redactedPath = prefix + redactPath(path);
  const redactedQs = redactQueryString(qs);
  return redactedQs ? `${redactedPath}?${redactedQs}` : redactedPath;
}
