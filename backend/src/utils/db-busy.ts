/**
 * The retryable 503 for a busy database (#751, #908), shared by the central
 * error handler (`src/index.ts`) and `respondWithError` so the two cannot
 * drift.
 *
 * - A transaction cancelled waiting on a lock (Prisma P2028, or PostgreSQL's
 *   `lock_timeout`) becomes a `TransactionTimeoutError`, body from
 *   `DetailedError.body()`, code `transaction_timeout`.
 * - A pg pool timeout or P2028 `maxWait` exhaustion renders `DB_BUSY_BODY`.
 *
 * Both carry `Retry-After` and are logged at `error` and captured: a lock
 * holder that outlasts the lock wait is the slow-database signal the on-call
 * runbook asks for. The gate: any other `AppError` keeps its own status and
 * body, whatever sits in its cause chain.
 */

import type { Response } from 'express';
import { DB_BUSY_BODY, DB_BUSY_RETRY_AFTER_SECONDS, classifyDbError } from '../models/pool-config';
import { AppError, TransactionTimeoutError } from './errors';

export interface DbBusyOutcome {
  body: { error: string; code?: string };
}

export function dbBusyOutcome(err: unknown): DbBusyOutcome | undefined {
  if (err instanceof TransactionTimeoutError) return { body: err.body() };
  if (err instanceof AppError) return undefined;
  const kind = classifyDbError(err);
  if (kind === 'lock_wait') return { body: new TransactionTimeoutError(err).body() };
  if (kind === 'busy') return { body: DB_BUSY_BODY };
  return undefined;
}

/** Answer the busy 503 with its body and `Retry-After`. */
export function sendDbBusy(res: Response, outcome: DbBusyOutcome): void {
  res.status(503).set('Retry-After', String(DB_BUSY_RETRY_AFTER_SECONDS)).json(outcome.body);
}
