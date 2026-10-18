/**
 * Prisma error mapping shared by services (#727).
 *
 * Kept out of `utils/errors.ts` so that file stays free of the Prisma import.
 */

import { Prisma } from '@prisma/client';
import { classifyDbError } from '../models/pool-config';
import { BadRequestError, TransactionTimeoutError } from './errors';

/** True for a unique-constraint violation (Prisma `P2002`). */
export function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** True when the record an `update`/`delete` targeted matched nothing (Prisma `P2025`). */
export function isRecordNotFound(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
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
 * as does every other error. Without `target`, any P2002 maps.
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
    throw err;
  }
}

/**
 * Run a transaction where a lock-wait timeout is expected contention (the two
 * supersede-resend transactions, #908): a P2028 expiry becomes a
 * `TransactionTimeoutError` marked `expected` (503, warn-level, not Sentry).
 * Any other error propagates; a P2028 from a transaction that is not wrapped
 * here is still answered 503 but logged at error and captured.
 */
export async function lockWaitExpected<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (classifyDbError(err) === 'lock_wait') {
      throw new TransactionTimeoutError(true, err);
    }
    throw err;
  }
}
