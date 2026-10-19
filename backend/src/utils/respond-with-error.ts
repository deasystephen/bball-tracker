/**
 * The single path a route `catch` takes to answer an error (#831).
 *
 * - A `NotFoundError`, when the route passes `notFound`, is answered 404 with
 *   that body whichever row was missing (the public by-token invitation routes).
 * - A 4xx `DetailedError` (402 `upgrade_required`, 400 `last_head_coach`, 429
 *   `resend_cooldown`, …) is answered with `error.body()` at its status.
 * - Any other 4xx `AppError` is answered `{ error: error.message }` at its
 *   status. Every subclass carries its own status, so a route never lists which
 *   ones it "handles"; the per-route `instanceof` allow-lists answered 500 for
 *   any subclass they forgot (a `ConflictError` from a service came back 500).
 * - A 5xx `AppError` keeps its status but answers the route's `fallback` body:
 *   its message is internal ("Database unavailable") and never reaches a client.
 * - A pg pool wait/connect timeout (`models/pool-config.ts#isPoolTimeoutError`,
 *   #751) is answered 503 with `Retry-After` and the central handler's retry
 *   body, like the central handler: the pool is saturated, not the route broken.
 *   A transaction cancelled waiting on a lock (Prisma P2028 or PostgreSQL
 *   `lock_timeout`, #908) is the `transaction_timeout` 503
 *   (`TransactionTimeoutError`, `DetailedError.body()`) with the same
 *   `Retry-After`. Classification and rendering are shared with the central
 *   handler (`utils/db-busy.ts`); both 503s are logged at `error` and captured.
 * - A non-`AppError` carrying a 4xx `status`/`statusCode` (a WorkOS SDK error,
 *   an `http-errors` error) keeps that status, the rule the central error
 *   handler applies through `sentry.ts#clientErrorStatus`, with the `fallback`
 *   body, since its message is a third party's.
 * - Anything else is 500 with the `fallback` body.
 * - When a stream already started the response (`res.headersSent`, the export
 *   routes), answering again would throw `ERR_HTTP_HEADERS_SENT`: the response
 *   is ended, and the line is logged as a 500 with `streamed: true` so
 *   `status:>=500` monitors see the failed export.
 *
 * Then, when `sentryFlow` is set and the outcome is a 5xx, the error goes to
 * Sentry with that flow tag and the request tags `sentryErrorHandler` attaches,
 * and the line is logged by the status (`logRouteError`: 4xx at `warn`,
 * anything else at `error`).
 *
 * The central error handler in `src/index.ts` stays the fallback for errors
 * handed to `next(err)` or thrown outside a route catch.
 */

import type { Response } from 'express';
import { dbBusyOutcome, sendDbBusy } from './db-busy';
import { AppError, DetailedError, NotFoundError } from './errors';
import { logRouteError } from './log-route-error';
import { captureRequestException, clientErrorStatus } from './sentry';

/** A route's 500 body: its message, plus any extra field it already answered. */
export type FallbackBody = { error: string } & Record<string, unknown>;

export interface RespondWithErrorOptions {
  /** Log message, e.g. `'Error getting team'`. */
  log: string;
  /** The route's body for an unexpected error, e.g. `'Failed to get team'`. */
  fallback: string | FallbackBody;
  /** Body for every `NotFoundError`, whichever row was missing. */
  notFound?: string;
  /** Sentry `flow` tag; when set, a 5xx outcome is reported to Sentry. */
  sentryFlow?: string;
}

export function respondWithError(res: Response, error: unknown, options: RespondWithErrorOptions): void {
  const fallback = typeof options.fallback === 'string' ? { error: options.fallback } : options.fallback;
  const streamed = res.headersSent;
  const busy = dbBusyOutcome(error);
  if (streamed) {
    res.end();
  } else if (busy) {
    sendDbBusy(res, busy);
  } else if (options.notFound !== undefined && error instanceof NotFoundError) {
    res.status(404).json({ error: options.notFound });
  } else if (error instanceof AppError && error.statusCode >= 500) {
    res.status(error.statusCode).json(fallback);
  } else if (error instanceof DetailedError) {
    res.status(error.statusCode).json(error.body());
  } else if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
  } else {
    res.status(clientErrorStatus(error) ?? 500).json(fallback);
  }

  const status = streamed ? 500 : res.statusCode;
  if (options.sentryFlow && status >= 500) {
    captureRequestException(error, res.req, { flow: options.sentryFlow });
  }
  if (streamed) {
    logRouteError({ statusCode: 500 }, options.log, error, { streamed: true });
  } else {
    logRouteError(res, options.log, error);
  }
}
