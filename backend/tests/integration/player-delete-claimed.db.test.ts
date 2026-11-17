/**
 * `DELETE /players/:id` never hard-deletes a claimed account (#1034), against a
 * REAL Postgres. Proves what the mocked suites cannot: the guarded write
 * `where: { id, deletedAt: null, AND: [{ workosUserId: null }] }` is accepted
 * by Prisma and matches no row once the account has a login, so a row claimed
 * between the unlocked read and the delete survives. Rows carry the run id and
 * are removed in afterAll.
 */
jest.unmock('../../src/models');
import prisma from '../../src/models';
import { PlayerService } from '../../src/services/player-service';
import { ClaimedAccountError } from '../../src/utils/errors';
import { DbFixtures } from '../support/db-fixtures';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'delclaimed');

let adminId: string;

beforeAll(async () => {
  adminId = await fx.user('admin', 'ADMIN');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

async function exists(id: string): Promise<boolean> {
  return (await prisma.user.count({ where: { id } })) === 1;
}

describe('PlayerService.deletePlayer and claimed accounts (#1034)', () => {
  it('refuses a claimed PLAYER for an ADMIN and keeps the row', async () => {
    const id = await fx.user('claimed', 'PLAYER');
    await prisma.user.update({ where: { id }, data: { workosUserId: `workos-claimed-${fx.run}` } });

    await expect(PlayerService.deletePlayer(id, adminId)).rejects.toBeInstanceOf(ClaimedAccountError);

    expect(await exists(id)).toBe(true);
  });

  it.each([
    ['managed', true],
    ['preprovisioned', false],
  ])('still deletes an unclaimed %s row (no login)', async (key, isManaged) => {
    const id = await fx.user(key, 'PLAYER');
    await prisma.user.update({ where: { id }, data: { isManaged } });

    await expect(PlayerService.deletePlayer(id, adminId)).resolves.toEqual({ success: true });

    expect(await exists(id)).toBe(false);
  });

  it('the guarded write itself matches nothing on a claimed row (the race)', async () => {
    const id = await fx.user('raced', 'PLAYER');
    await prisma.user.update({ where: { id }, data: { workosUserId: `workos-raced-${fx.run}` } });

    // Exactly the delete deletePlayer issues after its unlocked read said "unclaimed".
    await expect(
      prisma.user.delete({
        where: { id, deletedAt: null, AND: [{ workosUserId: null }] },
        select: { profilePictureUrl: true },
      })
    ).rejects.toMatchObject({ code: 'P2025' });

    expect(await exists(id)).toBe(true);
  });
});
