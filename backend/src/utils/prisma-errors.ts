/**
 * Prisma error mapping shared by services (#727).
 *
 * Kept out of `utils/errors.ts` so that file stays free of the Prisma import.
 */

import { Prisma } from '@prisma/client';
import { BadRequestError, TransactionTimeoutError } from './errors';

/** True for a unique-constraint violation (Prisma `P2002`). */
export function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** True when the record an `update`/`delete` targeted matched nothing (Prisma `P2025`). */
export function isRecordNotFound(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/** True when Prisma aborted an interactive transaction (`P2028`, e.g. the 5 s timeout while waiting on a row lock). */
export function isTransactionClosed(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028';
}

/**
 * Re-throw `err`, mapping a P2028 to the retryable 409 `transaction_timeout`
 * (#908) so a lock-wait loser never answers 500. Any other error propagates.
 */
export function rethrowTransactionTimeout(err: unknown): never {
  if (isTransactionClosed(err)) {
    throw new TransactionTimeoutError();
  }
  throw err;
}

/**
 * The constraint a P2002 names. With the pg driver adapter (Prisma 7) the
 * error carries no `meta.target`; the index name is at
 * `meta.driverAdapterError.cause.constraint.index` (verified against Postgres
 * 18, 2026-10-17). `meta.target` is still read for an engine that sets it.
 */
export function violatedConstraint(err: Prisma.PrismaClientKnownRequestError): {
  index?: string;
  fields?: string[];
} {
  const meta = err.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } };
      }
    | undefined;
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;

  const index =
    typeof constraint?.index === 'string'
      ? constraint.index
      : typeof meta?.target === 'string'
        ? meta.target
        : undefined;
  const fields = strings(constraint?.fields) ?? strings(meta?.target);
  return { index, fields };
}

/** True when the P2002 positively names `target`: an index name, or the exact column list. */
function violates(err: Prisma.PrismaClientKnownRequestError, target: string | string[]): boolean {
  const { index, fields } = violatedConstraint(err);
  if (typeof target === 'string') {
    return index === target;
  }
  return fields !== undefined && fields.length === target.length && target.every((f, i) => fields[i] === f);
}

/**
 * Run a create guarded by a check-then-insert pre-check. The pre-check and the
 * insert are not one transaction, so a request that loses the race to a
 * concurrent twin hits the unique index; that answers the same 400 the
 * pre-check does, never a 500.
 *
 * `target` names the unique the pre-check stands in for (index name, or column
 * list). A P2002 on any other unique of the model (`token @unique` on the
 * invitation tables) is not the race the message describes and propagates,
 * as does every other error, except a P2028 (transaction aborted while
 * waiting on a lock), which maps to the retryable 409 `transaction_timeout`
 * (#908). Without `target`, any P2002 maps.
 */
export async function createOrConflict<T>(
  run: () => Promise<T>,
  message: string,
  target?: string | string[]
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err) && (target === undefined || violates(err, target))) {
      throw new BadRequestError(message);
    }
    return rethrowTransactionTimeout(err);
  }
}
