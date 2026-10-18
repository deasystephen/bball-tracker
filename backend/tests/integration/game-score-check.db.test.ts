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
let gameId: string;

const scores = () =>
  prisma.game.findUniqueOrThrow({
    where: { id: gameId },
    select: { homeScore: true, awayScore: true },
  });

beforeAll(async () => {
  await fx.requireDatabase();
  org = await fx.org('team');
  gameId = await fx.game(org, { status: 'IN_PROGRESS' });
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('Game_score_non_negative_check (#825)', () => {
  it('rejects a negative homeScore and leaves the row untouched', async () => {
    await expect(
      prisma.game.update({ where: { id: gameId }, data: { homeScore: -1 } })
    ).rejects.toThrow(/Game_score_non_negative_check/);
    expect(await scores()).toEqual({ homeScore: 0, awayScore: 0 });
  });

  it('rejects a negative awayScore and leaves the row untouched', async () => {
    await expect(
      prisma.game.update({ where: { id: gameId }, data: { awayScore: -3 } })
    ).rejects.toThrow(/Game_score_non_negative_check/);
    expect(await scores()).toEqual({ homeScore: 0, awayScore: 0 });
  });

  it('still accepts zero and positive scores on the same row', async () => {
    await prisma.game.update({ where: { id: gameId }, data: { homeScore: 0, awayScore: 42 } });
    expect(await scores()).toEqual({ homeScore: 0, awayScore: 42 });
  });
});
