/**
 * Unit tests for the shared P2002 mapping (#727).
 */

import { Prisma } from '@prisma/client';
import { createOrConflict, isUniqueViolation } from '../../src/utils/prisma-errors';
import { BadRequestError } from '../../src/utils/errors';

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Prisma error', { code, clientVersion: 'test' });
}

describe('isUniqueViolation', () => {
  it('is true only for a known request error with code P2002', () => {
    expect(isUniqueViolation(knownError('P2002'))).toBe(true);
    expect(isUniqueViolation(knownError('P2025'))).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation({ code: 'P2002' })).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('createOrConflict', () => {
  it('returns what the create resolves to', async () => {
    await expect(createOrConflict(async () => ({ id: 'row-1' }), 'dup')).resolves.toEqual({ id: 'row-1' });
  });

  it('maps a P2002 to a BadRequestError carrying the given message', async () => {
    const error = await createOrConflict(async () => {
      throw knownError('P2002');
    }, 'Already exists').catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ statusCode: 400, message: 'Already exists' });
  });

  it('rethrows any other error unchanged', async () => {
    const fkError = knownError('P2003');
    await expect(
      createOrConflict(async () => {
        throw fkError;
      }, 'Already exists')
    ).rejects.toBe(fkError);
  });
});
