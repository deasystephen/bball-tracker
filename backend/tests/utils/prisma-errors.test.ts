/**
 * Unit tests for the shared Prisma error mapping (#727, #726).
 */

import { Prisma } from '@prisma/client';
import {
  createOrConflict,
  isRecordNotFound,
  isUniqueViolation,
  orNotFound,
  violatedConstraint,
} from '../../src/utils/prisma-errors';
import { BadRequestError, NotFoundError } from '../../src/utils/errors';
import { uniqueViolation } from '../factories';

function knownError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Prisma error', { code, clientVersion: 'test', meta });
}

const failWith = (err: unknown) => async (): Promise<never> => {
  throw err;
};

describe('isUniqueViolation / isRecordNotFound', () => {
  it('match only a known request error with their code', () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(isUniqueViolation(knownError('P2025'))).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation({ code: 'P2002' })).toBe(false);
    expect(isRecordNotFound(knownError('P2025'))).toBe(true);
    expect(isRecordNotFound(uniqueViolation())).toBe(false);
    expect(isRecordNotFound(undefined)).toBe(false);
  });
});

describe('violatedConstraint', () => {
  it('reads the index name the pg driver adapter reports', () => {
    expect(violatedConstraint(uniqueViolation('Season_leagueId_name_key'))).toEqual({
      index: 'Season_leagueId_name_key',
      fields: undefined,
    });
  });

  it('falls back to meta.target as a name or a column list', () => {
    expect(violatedConstraint(knownError('P2002', { target: 'User_email_key' })).index).toBe('User_email_key');
    expect(violatedConstraint(knownError('P2002', { target: ['teamId', 'name'] })).fields).toEqual(['teamId', 'name']);
  });

  it('reads adapter fields when the adapter reports columns instead of an index', () => {
    const err = knownError('P2002', {
      driverAdapterError: { cause: { constraint: { fields: ['teamId', 'playerId'] } } },
    });
    expect(violatedConstraint(err)).toEqual({ index: undefined, fields: ['teamId', 'playerId'] });
  });

  it('is empty when the error names nothing', () => {
    expect(violatedConstraint(uniqueViolation())).toEqual({ index: undefined, fields: undefined });
  });
});

describe('createOrConflict', () => {
  it('returns what the create resolves to', async () => {
    await expect(createOrConflict(async () => ({ id: 'row-1' }), 'dup', 'X_key')).resolves.toEqual({ id: 'row-1' });
  });

  it('maps a P2002 on the targeted index to a BadRequestError carrying the message', async () => {
    const error = await createOrConflict(failWith(uniqueViolation('X_key')), 'Already exists', 'X_key').catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ statusCode: 400, message: 'Already exists' });
  });

  it('maps a P2002 whose column list equals a targeted column list', async () => {
    const err = knownError('P2002', { target: ['teamId', 'name'] });
    await expect(createOrConflict(failWith(err), 'Already exists', ['teamId', 'name'])).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it('rethrows a P2002 on a different unique of the model (token collision)', async () => {
    const tokenClash = uniqueViolation('GuardianInvitation_token_key');
    await expect(
      createOrConflict(failWith(tokenClash), 'Already exists', 'GuardianInvitation_pending_childId_invitedEmail_key')
    ).rejects.toBe(tokenClash);
  });

  it('rethrows a P2002 that names nothing when a target is given, or names other columns', async () => {
    const anonymous = uniqueViolation();
    await expect(createOrConflict(failWith(anonymous), 'Already exists', 'X_key')).rejects.toBe(anonymous);
    const otherColumns = knownError('P2002', { target: ['token'] });
    await expect(createOrConflict(failWith(otherColumns), 'Already exists', ['teamId', 'name'])).rejects.toBe(
      otherColumns
    );
  });

  it('maps any P2002 when no target is given', async () => {
    await expect(createOrConflict(failWith(uniqueViolation()), 'Already exists')).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it('rethrows any other error unchanged', async () => {
    const fkError = knownError('P2003');
    await expect(createOrConflict(failWith(fkError), 'Already exists', 'X_key')).rejects.toBe(fkError);
  });
});

describe('orNotFound (#463)', () => {
  const gone = new NotFoundError('User is not a staff member of this team');

  it('returns the result when the write matches a row', async () => {
    await expect(orNotFound(async () => 'row', gone)).resolves.toBe('row');
  });

  it('throws the given error for a P2025', async () => {
    await expect(orNotFound(failWith(knownError('P2025')), gone)).rejects.toBe(gone);
  });

  it('propagates every other error unchanged', async () => {
    const p2002 = knownError('P2002');
    const boom = new Error('connection reset');
    await expect(orNotFound(failWith(p2002), gone)).rejects.toBe(p2002);
    await expect(orNotFound(failWith(boom), gone)).rejects.toBe(boom);
  });
});
