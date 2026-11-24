/**
 * Real-database proof that every pooled connection carries the lock_timeout
 * `models/pool-config.ts#buildDbPoolOptions` sets as a pg startup parameter (#944),
 * outside and inside a transaction. The cancel itself is proven per lock site
 * by the supersede, team-staff, account-deletion and stats-finalize suites.
 *
 * Also the one real deadlock in the suites: two transactions lock two User
 * rows in opposite order, PostgreSQL aborts one (40P01), and the error Prisma
 * surfaces classifies as the retryable `lock_wait`.
 */
jest.unmock('../../src/models');

import type { Prisma } from '@prisma/client';
import prisma from '../../src/models';
import { DB_LOCK_TIMEOUT_MS, classifyDbError, isLockTimeoutError } from '../../src/models/pool-config';
import { DbFixtures } from '../support/db-fixtures';

const fx = new DbFixtures(prisma, 'PoolLockTimeout');

beforeAll(async () => {
  await fx.requireDatabase();
});

afterAll(async () => {
  await fx.cleanup();
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

describe('a deadlock PostgreSQL breaks (40P01)', () => {
  jest.setTimeout(30_000);

  // Each transaction locks its own row, waits until the other has locked too,
  // then asks for the other's row: a cycle PostgreSQL's deadlock detector (1 s
  // by default, well inside the lock_timeout) breaks by aborting one side.
  async function deadlock(
    key: string,
    cross: (tx: Prisma.TransactionClient, other: string) => Promise<unknown>
  ): Promise<unknown> {
    const first = await fx.user(`${key}-a`, 'PLAYER');
    const second = await fx.user(`${key}-b`, 'PLAYER');
    let releaseBoth!: () => void;
    const bothLocked = new Promise<void>((resolve) => (releaseBoth = resolve));
    let locked = 0;
    const lockThenCross = (own: string, other: string): Promise<void> =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${own} FOR UPDATE`;
        locked += 1;
        if (locked === 2) releaseBoth();
        await bothLocked;
        await cross(tx, other);
      });

    const results = await Promise.allSettled([lockThenCross(first, second), lockThenCross(second, first)]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    return rejected[0].reason;
  }

  it.each([
    [
      'a raw query (P2010)',
      'P2010',
      (tx: Prisma.TransactionClient, other: string): Promise<unknown> =>
        tx.$queryRaw`SELECT id FROM "User" WHERE id = ${other} FOR UPDATE`,
    ],
    [
      'an ORM write (P2034)',
      'P2034',
      (tx: Prisma.TransactionClient, other: string): Promise<unknown> =>
        tx.user.updateMany({ where: { id: other }, data: { updatedAt: new Date() } }),
    ],
  ])('aborts exactly one side waiting in %s, and that error classifies as lock_wait', async (_name, code, cross) => {
    const err = await deadlock(`deadlock-${code}`, cross);

    expect((err as { code?: unknown }).code).toBe(code);
    expect(classifyDbError(err)).toBe('lock_wait');
    expect(isLockTimeoutError(err)).toBe(false);
  });
});
