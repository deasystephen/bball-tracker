/**
 * The retryable 503 for a busy database (#751, #908), shared by the central
 * error handler (`src/index.ts`) and `respondWithError` so the two cannot
 * drift.
 *
 * - A `TransactionTimeoutError` (thrown by `prisma-errors.ts#lockWaitExpected`
 *   where contention is expected) renders its own `DetailedError.body()` and
 *   carries its `expected` marker.
 * - A raw Prisma P2028 lock-wait expiry from any other transaction renders the
 *   same body but is NOT expected: it is logged at `error` and captured, so a
 *   slow transaction stays visible.
 * - A pg pool timeout or P2028 `maxWait` exhaustion renders `DB_BUSY_BODY`.
 */

import type { Response } from 'express';
import { DB_BUSY_BODY, DB_BUSY_RETRY_AFTER_SECONDS, classifyDbError } from '../models/pool-config';
import { TransactionTimeoutError } from './errors';

export interface DbBusyOutcome {
  body: { error: string; code?: string };
  /** True only for a marked `TransactionTimeoutError`: warn-level, no Sentry. */
  expected: boolean;
}

export function dbBusyOutcome(err: unknown): DbBusyOutcome | undefined {
  if (err instanceof TransactionTimeoutError) {
    return { body: err.body(), expected: err.expected };
  }
  const kind = classifyDbError(err);
  if (kind === 'lock_wait') return { body: new TransactionTimeoutError().body(), expected: false };
  if (kind === 'busy') return { body: DB_BUSY_BODY, expected: false };
  return undefined;
}

/** Answer `status` with `body`, adding `Retry-After` to every 503. */
export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status);
  if (status === 503) res.set('Retry-After', String(DB_BUSY_RETRY_AFTER_SECONDS));
  res.json(body);
}
