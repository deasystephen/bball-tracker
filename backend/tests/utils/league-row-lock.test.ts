/**
 * The League-row lock shared by every season writer (create, rollover, rename).
 */

import type { Prisma } from '@prisma/client';
import { lockLeagueRow } from '../../src/utils/league-row-lock';

function txReturning(rows: unknown[]): { tx: Prisma.TransactionClient; queryRaw: jest.Mock } {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  return { tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw };
}

describe('lockLeagueRow', () => {
  it('locks the league row FOR NO KEY UPDATE and answers true when it exists', async () => {
    const { tx, queryRaw } = txReturning([{ id: 'league-1' }]);

    await expect(lockLeagueRow(tx, 'league-1')).resolves.toBe(true);

    const [sql, ...params] = queryRaw.mock.calls[0];
    expect((sql as string[]).join('?')).toMatch(/FROM "League" WHERE "id" = \? FOR NO KEY UPDATE/);
    expect(params).toEqual(['league-1']);
  });

  it('answers false when the league no longer exists', async () => {
    const { tx } = txReturning([]);
    await expect(lockLeagueRow(tx, 'gone')).resolves.toBe(false);
  });
});
