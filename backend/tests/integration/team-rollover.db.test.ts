/**
 * REAL DATABASE test: `TeamService.rolloverTeam`, season rollover (#461).
 *
 * The service tests run the rollover against the shared Prisma mock. This
 * suite runs it against Postgres, where the things that matter are real: the
 * `@@unique([lineageId, seasonId])` index that makes a repeat idempotent, the
 * lineage row lock that serializes two concurrent rollovers, the `createMany`
 * copies, and the player career view reading last season's stats from the
 * row the rollover left behind.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { BadRequestError, ForbiddenError } from '../../src/utils/errors';
import { TeamService } from '../../src/services/team-service';
import { StatsService } from '../../src/services/stats-service';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.setTimeout(60000);

const fx = new DbFixtures(prisma, 'Rollover');

interface Club {
  org: Org;
  coach: string;
  assistant: string;
  manager: string;
  players: string[];
  tombstone: string;
  lineageId: string;
}

/**
 * A league whose head coach is also its admin (the personal-league shape), an
 * assistant coach, a custom-role team manager, two players (jersey 0 is valid)
 * and a deleted player, plus one finished game with the first player's box
 * score.
 */
async function club(key: string): Promise<Club> {
  const coach = await fx.user(`${key}-coach`, 'COACH');
  const assistant = await fx.user(`${key}-asst`, 'COACH');
  const manager = await fx.user(`${key}-mgr`, 'PLAYER');
  const playerA = await fx.user(`${key}-pa`, 'PLAYER');
  const playerB = await fx.user(`${key}-pb`, 'PLAYER');
  const tombstone = await fx.user(`${key}-gone`, 'PLAYER');

  const org = await fx.org(key);
  await fx.leagueAdmin(coach, org);
  await fx.staff(coach, org);
  const assistantRole = await prisma.teamRole.create({
    data: { teamId: org.teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageTeam: true, canManageRoster: true },
    select: { id: true },
  });
  await fx.staff(assistant, org, assistantRole.id);
  const customRole = await prisma.teamRole.create({
    data: { teamId: org.teamId, type: 'CUSTOM', name: 'Scorekeeper', canTrackStats: true },
    select: { id: true },
  });
  await fx.staff(manager, org, customRole.id);

  await prisma.teamMember.create({ data: { teamId: org.teamId, playerId: playerA, jerseyNumber: 0, position: 'PG' } });
  await prisma.teamMember.create({ data: { teamId: org.teamId, playerId: playerB, jerseyNumber: 23 } });
  await fx.member(tombstone, org);
  await prisma.user.update({ where: { id: tombstone }, data: { deletedAt: new Date() } });

  const gameId = await fx.game(org, { status: 'FINISHED' });
  await prisma.playerStats.create({
    data: { gameId, playerId: playerA, points: 17, fieldGoalsMade: 7, fieldGoalsAttempted: 12 },
  });

  const team = await prisma.team.findUniqueOrThrow({ where: { id: org.teamId }, select: { lineageId: true } });
  return { org, coach, assistant, manager, players: [playerA, playerB], tombstone, lineageId: team.lineageId };
}

beforeAll(async () => {
  await fx.requireDatabase();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('TeamService.rolloverTeam against Postgres (#461)', () => {
  it('creates the next team-season with the roster, roles and staff, and leaves the old row intact', async () => {
    const c = await club('carry');
    const seasonName = `Next-${fx.run}`;

    const { team, created } = await TeamService.rolloverTeam(c.org.teamId, { seasonName, ageGroup: 'U13' }, c.coach);

    expect(created).toBe(true);
    expect(team.id).not.toBe(c.org.teamId);
    expect(team.name).toBe(c.org.teamName);

    const row = await prisma.team.findUniqueOrThrow({
      where: { id: team.id },
      select: { lineageId: true, ageGroup: true, season: { select: { name: true, leagueId: true, isActive: true } } },
    });
    expect(row).toEqual({
      lineageId: c.lineageId,
      ageGroup: 'U13',
      season: { name: seasonName, leagueId: c.org.leagueId, isActive: true },
    });

    const members = await prisma.teamMember.findMany({
      where: { teamId: team.id },
      select: { playerId: true, jerseyNumber: true, position: true },
      orderBy: { jerseyNumber: 'asc' },
    });
    expect(members).toEqual([
      { playerId: c.players[0], jerseyNumber: 0, position: 'PG' },
      { playerId: c.players[1], jerseyNumber: 23, position: null },
    ]);

    const staff = await prisma.teamStaff.findMany({
      where: { teamId: team.id },
      select: { userId: true, role: { select: { teamId: true, name: true, type: true, canTrackStats: true } } },
    });
    expect(staff).toHaveLength(3);
    expect(new Map(staff.map((s) => [s.userId, s.role]))).toEqual(
      new Map([
        [c.coach, { teamId: team.id, name: 'HEAD_COACH', type: 'HEAD_COACH', canTrackStats: true }],
        [c.assistant, { teamId: team.id, name: 'Assistant Coach', type: 'ASSISTANT_COACH', canTrackStats: false }],
        [c.manager, { teamId: team.id, name: 'Scorekeeper', type: 'CUSTOM', canTrackStats: true }],
      ])
    );

    // Nothing season-bound comes along.
    expect(await prisma.game.count({ where: { teamId: team.id } })).toBe(0);

    // The old row keeps its roster, its staff and its game.
    expect(await prisma.teamMember.count({ where: { teamId: c.org.teamId } })).toBe(3);
    expect(await prisma.teamStaff.count({ where: { teamId: c.org.teamId } })).toBe(3);
    expect(await prisma.game.count({ where: { teamId: c.org.teamId } })).toBe(1);
  });

  it('is idempotent: a repeat returns the same row and writes nothing', async () => {
    const c = await club('repeat');
    const seasonName = `Next-${fx.run}`;

    const first = await TeamService.rolloverTeam(c.org.teamId, { seasonName }, c.coach);
    const second = await TeamService.rolloverTeam(c.org.teamId, { seasonName }, c.coach);

    expect(second).toEqual({ team: expect.objectContaining({ id: first.team.id }), created: false });
    expect(await prisma.team.count({ where: { lineageId: c.lineageId } })).toBe(2);
    expect(await prisma.teamMember.count({ where: { teamId: first.team.id } })).toBe(2);
  });

  it('serializes two concurrent rollovers of one lineage onto one new row', async () => {
    const c = await club('race');
    const seasonName = `Race-${fx.run}`;

    const results = await Promise.all([
      TeamService.rolloverTeam(c.org.teamId, { seasonName }, c.coach),
      TeamService.rolloverTeam(c.org.teamId, { seasonName }, c.coach),
    ]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results[0].team.id).toBe(results[1].team.id);
    expect(await prisma.team.count({ where: { lineageId: c.lineageId } })).toBe(2);
    expect(await prisma.season.count({ where: { leagueId: c.org.leagueId, name: seasonName } })).toBe(1);
  });

  it('refuses the current season and an assistant coach', async () => {
    const c = await club('deny');

    await expect(
      TeamService.rolloverTeam(c.org.teamId, { seasonId: c.org.seasonId }, c.coach)
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      TeamService.rolloverTeam(c.org.teamId, { seasonName: `Next-${fx.run}` }, c.assistant)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.team.count({ where: { lineageId: c.lineageId } })).toBe(1);
  });

  it('lets a head coach who is not a league admin roll into an existing season but not create one', async () => {
    const c = await club('club');
    await prisma.leagueAdmin.deleteMany({ where: { leagueId: c.org.leagueId, userId: c.coach } });
    const existing = await prisma.season.create({
      data: { leagueId: c.org.leagueId, name: `Made-by-admin-${fx.run}` },
      select: { id: true },
    });

    await expect(
      TeamService.rolloverTeam(c.org.teamId, { seasonName: `Coach-made-${fx.run}` }, c.coach)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.season.count({ where: { leagueId: c.org.leagueId } })).toBe(2);

    const { team, created } = await TeamService.rolloverTeam(c.org.teamId, { seasonId: existing.id }, c.coach);
    expect(created).toBe(true);
    expect(team.seasonId).toBe(existing.id);
  });

  it("keeps last season's stats in the player career view after a rollover", async () => {
    const c = await club('career');
    const { team } = await TeamService.rolloverTeam(c.org.teamId, { seasonName: `Next-${fx.run}` }, c.coach);

    const career = await StatsService.getPlayerOverallStats(c.players[0], c.coach);

    const byTeam = new Map(career.teams.map((t) => [t.teamId, t.stats]));
    expect(byTeam.get(c.org.teamId)).toEqual(
      expect.objectContaining({ gamesPlayed: 1, points: 17, jerseyNumber: 0 })
    );
    expect(byTeam.get(team.id)).toEqual(expect.objectContaining({ gamesPlayed: 0, points: 0, jerseyNumber: 0 }));
    expect(career.careerTotals).toEqual(expect.objectContaining({ gamesPlayed: 1, points: 17 }));
  });
});
