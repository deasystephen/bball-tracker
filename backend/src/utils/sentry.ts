/**
 * Sentry initialization and helpers for the backend.
 *
 * Init is gated on `SENTRY_DSN` being set. If the DSN is missing, every helper
 * no-ops so local dev and tests don't ship events. `SENTRY_ENVIRONMENT` further
 * scopes events (e.g. `production`, `staging`). `SENTRY_RELEASE` is populated
 * in CI from the git SHA so stack traces link to a specific deploy.
 */

import * as Sentry from '@sentry/node';
import type { ErrorEvent, Event, EventHint } from '@sentry/node';
import type { Request, Response, NextFunction } from 'express';

type SentryRequest = NonNullable<Event['request']>;

let initialized = false;

/**
 * Keys that should never be forwarded to Sentry, regardless of where they appear.
 * Matched case-insensitively against header names, cookie names, query params,
 * and request body fields.
 */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'jwt',
  'session',
  'x-api-key',
  'x-auth-token',
  'email',
  'emailbody',
  'email_body',
  'body',
  'otp',
];

const SCRUBBED = '[scrubbed]';

function scrubObject<T extends Record<string, unknown>>(input: T | undefined): T | undefined {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return (input as unknown[]).map(v =>
      v && typeof v === 'object' ? scrubObject(v as Record<string, unknown>) : v
    ) as unknown as T;
  }
  const out: Record<string, unknown> = { ...input };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some(k => lower.includes(k))) {
      out[key] = SCRUBBED;
      continue;
    }
    const val = out[key];
    if (val && typeof val === 'object') {
      out[key] = scrubObject(val as Record<string, unknown>);
    }
  }
  return out as T;
}

function scrubRequest(req: SentryRequest | undefined): SentryRequest | undefined {
  if (!req) return req;
  const scrubbed: SentryRequest = { ...req };
  if (scrubbed.headers) scrubbed.headers = scrubObject(scrubbed.headers as Record<string, unknown>) as typeof scrubbed.headers;
  if (scrubbed.cookies) scrubbed.cookies = scrubObject(scrubbed.cookies as Record<string, unknown>) as typeof scrubbed.cookies;
  if (scrubbed.query_string && typeof scrubbed.query_string === 'object') {
    scrubbed.query_string = scrubObject(scrubbed.query_string as Record<string, unknown>) as typeof scrubbed.query_string;
  }
  // Always drop request bodies entirely — too easy to leak PII.
  if ('data' in scrubbed) scrubbed.data = SCRUBBED;
  return scrubbed;
}

/**
 * beforeSend hook: strip obvious PII from the event before it leaves the process.
 * Exported for unit testing. Uses the loose `Event` shape (not `ErrorEvent`) so
 * tests can construct minimal fixtures.
 */
export function beforeSend(event: Event, _hint?: EventHint): Event {
  if (event.request) event.request = scrubRequest(event.request);
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts) as Event['contexts'];
  // Scrub breadcrumb data too
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(b => ({
      ...b,
      data: b.data ? scrubObject(b.data as Record<string, unknown>) : b.data,
    }));
  }
  return event;
}

/**
 * Initialize Sentry. Safe to call multiple times — subsequent calls are no-ops.
 * No-op when `SENTRY_DSN` is unset (dev, tests) or set to the literal
 * sentinel `"disabled"` (production before a real DSN is provisioned).
 * The sentinel exists because AWS Secrets Manager rejects empty strings,
 * so the Terraform-managed secret holds "disabled" until the var is set.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || dsn === 'disabled') return;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    // Conservative defaults; tune post-GA.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    sendDefaultPii: false,
    beforeSend: (event: ErrorEvent, hint: EventHint) => beforeSend(event, hint) as ErrorEvent,
  });
  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

/**
 * Express error handler that forwards the error to Sentry (if enabled) before
 * calling `next(err)` so downstream handlers still run.
 */
export function sentryErrorHandler(
  err: Error,
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (initialized) {
    Sentry.withScope(scope => {
      if (req.user) {
        scope.setUser({ id: req.user.id });
      }
      if (req.requestId) {
        scope.setTag('request_id', req.requestId);
      }
      scope.setTag('method', req.method);
      scope.setTag('route', req.route?.path || req.originalUrl);
      Sentry.captureException(err);
    });
  }
  next(err);
}
