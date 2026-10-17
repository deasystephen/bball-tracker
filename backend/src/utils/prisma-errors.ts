/**
 * Prisma error mapping shared by services (#727).
 *
 * Kept out of `utils/errors.ts` so that file stays free of the Prisma import.
 */

import { Prisma } from '@prisma/client';
import { BadRequestError } from './errors';

/** True for a unique-constraint violation (Prisma `P2002`). */
export function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Run a create guarded by a check-then-insert pre-check. The pre-check and the
 * insert are not one transaction, so a request that loses the race to a
 * concurrent twin hits the unique index; that answers the same 400 the
 * pre-check does, never a 500. Any other error propagates unchanged.
 */
export async function createOrConflict<T>(run: () => Promise<T>, message: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BadRequestError(message);
    }
    throw err;
  }
}
