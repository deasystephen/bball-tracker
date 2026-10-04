/**
 * The game-row lock shared by event writes, PATCH homeScore and stats finalization.
 */

import type { Prisma } from '@prisma/client';
import { lockGameRow } from '../../src/utils/game-row-lock';

function txReturning(rows: unknown[]): { tx: Prisma.TransactionClient; queryRaw: jest.Mock } {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  return { tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw };
}

describe('lockGameRow', () => {
  it('locks the game row FOR UPDATE and returns its status and scores', async () => {
    const row = { status: 'FINISHED', homeScore: 12, awayScore: 4 };
    const { tx, queryRaw } = txReturning([row]);

    await expect(lockGameRow(tx, 'game-1')).resolves.toEqual(row);

    const [sql, ...params] = queryRaw.mock.calls[0];
    expect((sql as string[]).join('?')).toMatch(/FROM "Game" WHERE "id" = \? FOR UPDATE/);
    expect(params).toEqual(['game-1']);
  });

  it('throws NotFoundError when the game no longer exists', async () => {
    const { tx } = txReturning([]);

    await expect(lockGameRow(tx, 'gone')).rejects.toMatchObject({ statusCode: 404, message: 'Game not found' });
  });
});
