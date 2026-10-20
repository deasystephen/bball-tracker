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
  // pg_settings.setting is the raw value in the GUC's base unit (ms here), so
  // the comparison does not depend on how PostgreSQL pretty-prints it.
  const expected = String(DB_LOCK_TIMEOUT_MS);

  it('is set on a pooled connection', async () => {
    const [{ setting }] = await prisma.$queryRaw<
      { setting: string }[]
    >`SELECT setting FROM pg_settings WHERE name = 'lock_timeout'`;
    expect(setting).toBe(expected);
  });

  it('is set inside an interactive transaction without any SET LOCAL', async () => {
    const value = await prisma.$transaction(async (tx) => {
      const [{ setting }] = await tx.$queryRaw<
        { setting: string }[]
      >`SELECT setting FROM pg_settings WHERE name = 'lock_timeout'`;
      return setting;
    });
    expect(value).toBe(expected);
  });
});
