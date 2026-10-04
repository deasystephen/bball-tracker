/**
 * REAL DATABASE test: the caller scoping of the player directory,
 * `PlayerService.getPlayerById` and `PlayerService.listPlayers` (#685).
 *
 * Both read through `utils/permissions#teamAccessWhere` (staff OR member OR
 * league admin OR guardian of a member) applied to the teams a player is
 * rostered on. A private two-branch copy once left league admins and
 * guardians with a 404; the service suite only compares `where` objects, so
 * this one runs the real queries.
 *
 * COVERAGE SHAPE, as in `list-access.db.test.ts`: one caller per branch, each
 * qualifying through exactly one, so a dropped branch fails; a same-league
 * sibling team and a separate org, so a branch that is too wide fails too.
 *
 *   League A ── team A1: target, childMember (guardianOnly's child), memberOnly; staff staffOnly
 *            └─ team A2: a2Player
 *   League B ── team B1: b1Player; staff orgBStaff
 *   adminOnly is a league admin of A and on no team.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { DbFixtures } from '../support/db-fixtures';
import { PlayerService } from '../../src/services/player-service';
import { NotFoundError } from '../../src/utils/errors';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'PlayerDir');
const { users } = fx;

const ROLE: Record<string, string> = {};

async function caller(key: string, role: 'PLAYER' | 'COACH' | 'PARENT'): Promise<string> {
  ROLE[key] = role;
  return fx.user(key, role);
}

const as = (key: string): { id: string; role: string } => ({ id: users[key], role: ROLE[key] });

/** Directory ids visible to `key`, limited to this run's rows by the name search. */
async function listed(key: string): Promise<string[]> {
  const result = await PlayerService.listPlayers({ search: fx.run, limit: 100, offset: 0 }, as(key));
  return result.players.map((p) => p.id).sort();
}

const ids = (...keys: string[]): string[] => keys.map((k) => users[k]).sort();

beforeAll(async () => {
  await fx.requireDatabase();

  const a1 = await fx.org('A1');
  const a2 = await fx.org('A2', { league: a1 });
  const b1 = await fx.org('B1');

  await fx.member(await caller('target', 'PLAYER'), a1);
  await fx.member(await caller('childMember', 'PLAYER'), a1);
  await fx.member(await caller('a2Player', 'PLAYER'), a2);
  await fx.member(await caller('b1Player', 'PLAYER'), b1);

  await fx.leagueAdmin(await caller('adminOnly', 'COACH'), a1);
  await fx.staff(await caller('staffOnly', 'COACH'), a1);
  await fx.member(await caller('memberOnly', 'PLAYER'), a1);
  await fx.guardian(await caller('guardianOnly', 'PARENT'), users.childMember);

  await fx.staff(await caller('orgBStaff', 'COACH'), b1);
  await caller('outsider', 'PLAYER');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('GET /players/:id scoping against a real database (#685)', () => {
  it.each([
    ['league admin', 'adminOnly'],
    ['staff', 'staffOnly'],
    ['member', 'memberOnly'],
    ['guardian of a member', 'guardianOnly'],
  ])('a %s reads a player on the team, without email', async (_label, key) => {
    const player = await PlayerService.getPlayerById(users.target, as(key));
    expect(player.id).toBe(users.target);
    expect(player.email).toBeNull();
  });

  it('a guardian reads their own child', async () => {
    const child = await PlayerService.getPlayerById(users.childMember, as('guardianOnly'));
    expect(child.id).toBe(users.childMember);
  });

  it('the league-admin branch spans the league: a sibling team is readable', async () => {
    await expect(PlayerService.getPlayerById(users.a2Player, as('adminOnly'))).resolves.toMatchObject({
      id: users.a2Player,
    });
  });

  it.each([
    ['staff of A1', 'staffOnly', 'a2Player'],
    ['a member of A1', 'memberOnly', 'a2Player'],
    ['a guardian of an A1 member', 'guardianOnly', 'a2Player'],
    ['the league admin of A', 'adminOnly', 'b1Player'],
    ['staff of another org', 'orgBStaff', 'target'],
    ['an unaffiliated caller', 'outsider', 'target'],
  ])('%s (%s) gets 404 for %s', async (_label, key, targetKey) => {
    await expect(PlayerService.getPlayerById(users[targetKey], as(key))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('GET /players scoping against a real database (#685)', () => {
  it('league admin: every player on every team in the league, not another league', async () => {
    expect(await listed('adminOnly')).toEqual(ids('target', 'childMember', 'memberOnly', 'a2Player'));
  });

  it('staff: the players on their team only', async () => {
    expect(await listed('staffOnly')).toEqual(ids('target', 'childMember', 'memberOnly'));
  });

  it('member: themselves and their teammates', async () => {
    expect(await listed('memberOnly')).toEqual(ids('target', 'childMember', 'memberOnly'));
  });

  it("guardian: the child and the child's teammates", async () => {
    expect(await listed('guardianOnly')).toEqual(ids('target', 'childMember', 'memberOnly'));
  });

  it('staff of another org sees none of league A', async () => {
    expect(await listed('orgBStaff')).toEqual(ids('b1Player'));
  });

  it('an unaffiliated player sees only themselves', async () => {
    expect(await listed('outsider')).toEqual(ids('outsider'));
  });

  it('never returns email to a non-admin caller', async () => {
    const result = await PlayerService.listPlayers({ search: fx.run, limit: 100, offset: 0 }, as('adminOnly'));
    expect(result.players.length).toBeGreaterThan(0);
    for (const p of result.players) {
      expect(p).not.toHaveProperty('email');
    }
  });
});
