/**
 * Sentry initialization and helpers for the backend.
 *
 * Init is gated on `SENTRY_DSN` being set. If the DSN is missing, every helper
 * no-ops so local dev and tests don't ship events. `SENTRY_ENVIRONMENT` further
 * scopes events (e.g. `production`, `staging`). `SENTRY_RELEASE` is populated
 * in CI from the git SHA so stack traces link to a specific deploy.
 */

import * as Sentry from '@sentry/node';
import type { ErrorEvent, Event, EventHint, NodeOptions } from '@sentry/node';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors';
import { redactQueryObject, redactQueryString, redactUrl } from './redact';

type SentryRequest = NonNullable<Event['request']>;
/** `@sentry/node` doesn't re-export `TransactionEvent`; derive it from the option signature. */
export type TransactionEvent = Parameters<NonNullable<NodeOptions['beforeSendTransaction']>>[0];

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
  // `url` carries the query string and secret path segments (`/by-token/<x>`) —
  // redact both rather than dropping the URL so events stay triageable (audit #15).
  if (typeof scrubbed.url === 'string') scrubbed.url = redactUrl(scrubbed.url);
  if (typeof scrubbed.query_string === 'string') {
    scrubbed.query_string = redactQueryString(scrubbed.query_string);
  } else if (scrubbed.query_string && typeof scrubbed.query_string === 'object') {
    scrubbed.query_string = redactQueryObject(
      scrubObject(scrubbed.query_string as Record<string, unknown>)
    ) as typeof scrubbed.query_string;
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
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.transaction) event.transaction = redactUrl(event.transaction);
  return event;
}

const URL_DATA_KEYS = ['url', 'http.url', 'http.target', 'http.route', 'url.full', 'url.path', 'url.query'];

/** Scrub a span/trace `data` bag by key name, then redact any URL-valued keys. */
function scrubDataBag<T extends object>(data: T): T {
  const out = scrubObject(data as Record<string, unknown>) as Record<string, unknown>;
  for (const key of URL_DATA_KEYS) {
    if (typeof out[key] === 'string') out[key] = redactUrl(out[key] as string);
  }
  return out as T;
}

function scrubBreadcrumb<B extends { data?: object }>(b: B): B {
  if (!b.data) return b;
  return { ...b, data: scrubDataBag(b.data) };
}

/**
 * beforeSendTransaction hook: performance transactions bypass `beforeSend` but
 * carry the same `request.url` / transaction name / span URLs, so apply the
 * same redaction (audit #15). Exported for unit testing.
 */
export function beforeSendTransaction(event: TransactionEvent, _hint?: EventHint): TransactionEvent {
  if (event.request) event.request = scrubRequest(event.request);
  if (event.transaction) event.transaction = redactUrl(event.transaction);
  if (event.contexts?.trace?.data) {
    event.contexts.trace.data = scrubDataBag(event.contexts.trace.data);
  }
  if (event.spans) {
    event.spans = event.spans.map(span => {
      const out = { ...span };
      if (typeof out.description === 'string') out.description = redactUrl(out.description);
      if (out.data) out.data = scrubDataBag(out.data);
      return out;
    });
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
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
    beforeSendTransaction: (event: TransactionEvent, hint: EventHint) => beforeSendTransaction(event, hint),
  });
  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

/**
 * Report an error to Sentry from inside a route handler that catches and
 * swallows the error (responding with its own status) instead of delegating to
 * the central `sentryErrorHandler` middleware. No-ops when Sentry is disabled.
 * `tags` attach context (e.g. `{ flow: 'auth-callback' }`) to aid triage.
 */
export function captureException(
  error: unknown,
  tags?: Record<string, string>
): void {
  if (!initialized) return;
  Sentry.withScope(scope => {
    if (tags) scope.setTags(tags);
    Sentry.captureException(error);
  });
}

/**
 * Extract a 4xx status from a non-AppError thrown by third-party middleware.
 * body-parser / `http-errors` set `status` + `statusCode` on
 * `entity.parse.failed` (400) and `entity.too.large` (413). Returns
 * `undefined` when the error carries no client-error status (audit #28).
 */
export function clientErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  const status =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined && Number.isInteger(status) && status >= 400 && status < 500) return status;
  return undefined;
}

/**
 * Operational 4xx errors (expired token, bad input, not found, 402 upgrade
 * prompts) are expected client outcomes, not defects — reporting each one as
 * an error is noise that buries real failures. Also covers body-parser errors
 * (malformed JSON, oversized body) that carry a 4xx `status` (audit #28).
 * 5xx and other non-AppError throws are still captured.
 */
export function isExpectedClientError(err: unknown): boolean {
  if (err instanceof AppError) return err.isOperational && err.statusCode < 500;
  return clientErrorStatus(err) !== undefined;
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
  if (initialized && !isExpectedClientError(err)) {
    Sentry.withScope(scope => {
      if (req.user) {
        scope.setUser({ id: req.user.id });
      }
      if (req.requestId) {
        scope.setTag('request_id', req.requestId);
      }
      scope.setTag('method', req.method);
      scope.setTag('route', req.route?.path || redactUrl(req.originalUrl));
      Sentry.captureException(err);
    });
  }
  next(err);
}
