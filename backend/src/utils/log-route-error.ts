/**
 * Logging for the `catch` block of a route handler that answers its own error
 * (#656). Call it as the LAST statement of the catch, after the response
 * status is set, so the level follows the status the client actually got:
 *
 * - 4xx (an expected client outcome: validation 400, 402 upgrade, 403, 404,
 *   409, 429) → `warn`;
 * - 5xx, or no error status set at all → `error`.
 *
 * This is the same warn-for-4xx rule the central error handler in
 * `src/index.ts` applies to errors handed to `next(err)`; together they keep
 * `@level:error` meaning "5xx or a failed external call"
 * (`docs/architecture/backend-services.md#logging`).
 *
 * Reading the sent status rather than classifying the thrown error matters
 * because most catches answer a fixed list of `AppError` subclasses and 500
 * for anything else: a 4xx `AppError` the route does not list is answered 500
 * and must still be logged at `error`.
 *
 * `requestId` and `userId` come from the request context; pass ids only in
 * `context`, never a name, an email or a URL (`utils/redact.ts`).
 */

import type { Response } from 'express';
import { logger } from './logger';

export function logRouteError(
  res: Pick<Response, 'statusCode'>,
  message: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  const status = res.statusCode;
  const log = status >= 400 && status < 500 ? logger.warn : logger.error;
  log(message, {
    ...context,
    status,
    error: error instanceof Error ? error.message : String(error),
  });
}
