/**
 * The single path a route `catch` takes to answer an error (#831).
 *
 * - A `DetailedError` (402 `upgrade_required`, 400 `last_head_coach`, 429
 *   `resend_cooldown`, …) is answered with `error.body()` at its status.
 * - Any other `AppError` is answered `{ error: error.message }` at its status.
 *   Every subclass carries its own status, so a route never lists which ones
 *   it "handles"; the per-route `instanceof` allow-lists answered 500 for any
 *   subclass they forgot (a `ConflictError` from a service came back 500).
 * - Anything else is the route's own 500 body (`fallback`).
 * - When a stream already started the response (`res.headersSent`, the export
 *   routes), answering again would throw `ERR_HTTP_HEADERS_SENT` and lose the
 *   log line: the response is ended instead.
 *
 * Then, when `sentryFlow` is set and the answer is a 5xx (or a broken stream),
 * the error goes to Sentry tagged with that flow, and the line is logged by
 * the status actually sent (`logRouteError`: 4xx at `warn`, anything else at `error`).
 *
 * This is the same serialization the central error handler in `src/index.ts`
 * applies to errors handed to `next(err)`; that handler stays the fallback for
 * errors thrown outside a route catch. `context` carries ids only, never a
 * name, an email or a URL.
 */

import type { Response } from 'express';
import { AppError, DetailedError } from './errors';
import { logRouteError } from './log-route-error';
import { captureException } from './sentry';

/** A route's 500 body: its message, plus any extra field it already answered. */
export type FallbackBody = { error: string } & Record<string, unknown>;

export interface RespondWithErrorOptions {
  /** Log message, e.g. `'Error getting team'`. */
  log: string;
  /** The route's 500 body for an unexpected error, e.g. `'Failed to get team'`. */
  fallback: string | FallbackBody;
  /** Extra ids for the log line. */
  context?: Record<string, unknown>;
  /** Sentry `flow` tag; when set, a 5xx answer is reported to Sentry. */
  sentryFlow?: string;
}

export function respondWithError(res: Response, error: unknown, options: RespondWithErrorOptions): void {
  const streamed = res.headersSent;
  if (streamed) {
    res.end();
  } else if (error instanceof DetailedError) {
    res.status(error.statusCode).json(error.body());
  } else if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
  } else {
    res.status(500).json(typeof options.fallback === 'string' ? { error: options.fallback } : options.fallback);
  }
  if (options.sentryFlow && (streamed || res.statusCode >= 500)) {
    captureException(error, { flow: options.sentryFlow });
  }
  logRouteError(res, options.log, error, options.context);
}
