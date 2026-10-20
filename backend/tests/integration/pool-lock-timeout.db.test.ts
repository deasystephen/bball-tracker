/**
 * Real-database proof that every pooled connection carries the lock_timeout
 * `models/pool-config.ts#DB_POOL_OPTIONS` sets as a pg startup option (#944),
 * outside and inside a transaction. The cancel itself is proven per lock site
 * by the supersede, team-staff, account-deletion and stats-finalize suites.
 */
jest.unmock('../../src/models');

import prisma from '../../src/models';
import { DB_LOCK_TIMEOUT_MS } from '../../src/models/pool-config';
import { DbFixtures } from '../support/db-fixtures';

const fx = new DbFixtures(prisma, 'PoolLockTimeout');

beforeAll(async () => {
  await fx.requireDatabase();
});

describe('pool-wide lock_timeout (#944)', () => {
  const expected = `${DB_LOCK_TIMEOUT_MS / 1000}s`;

  it('is set on a pooled connection', async () => {
    const [{ lock_timeout }] = await prisma.$queryRaw<
      { lock_timeout: string }[]
    >`SELECT current_setting('lock_timeout') AS lock_timeout`;
    expect(lock_timeout).toBe(expected);
  });

  it('is set inside an interactive transaction without any SET LOCAL', async () => {
    const value = await prisma.$transaction(async (tx) => {
      const [{ lock_timeout }] = await tx.$queryRaw<
        { lock_timeout: string }[]
      >`SELECT current_setting('lock_timeout') AS lock_timeout`;
      return lock_timeout;
    });
    expect(value).toBe(expected);
  });
});
