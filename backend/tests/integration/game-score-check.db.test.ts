/**
 * REAL DATABASE test: the `Game_score_non_negative_check` constraint (#825).
 *
 * Scores are derived and validated in the service layer, but nothing there can
 * stop a future write path that bypasses it. The database refuses a negative
 * `homeScore` or `awayScore` on its own. Mocked Prisma cannot see a constraint.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { DbFixtures, Org } from '../support/db-fixtures';

jest.setTimeout(60000);

const fx = new DbFixtures(prisma, 'ScoreCheck');
let org: Org;

beforeAll(async () => {
  await fx.requireDatabase();
  org = await fx.org('team');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('Game_score_non_negative_check (#825)', () => {
  it('rejects a negative homeScore', async () => {
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    await expect(
      prisma.game.update({ where: { id: gameId }, data: { homeScore: -1 } })
    ).rejects.toThrow(/Game_score_non_negative_check/);
  });

  it('rejects a negative awayScore', async () => {
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    await expect(
      prisma.game.update({ where: { id: gameId }, data: { awayScore: -3 } })
    ).rejects.toThrow(/Game_score_non_negative_check/);
  });

  it('still accepts zero and positive scores', async () => {
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    const updated = await prisma.game.update({
      where: { id: gameId },
      data: { homeScore: 0, awayScore: 42 },
      select: { homeScore: true, awayScore: true },
    });
    expect(updated).toEqual({ homeScore: 0, awayScore: 42 });
  });
});
