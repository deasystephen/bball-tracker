/**
 * REAL DATABASE test: who may read a player's stats (#589).
 *
 * `StatsService.getPlayerOverallStats` used to decide access with its own copy
 * of the team access rule. The copy had three branches (league admin, staff,
 * member) and no guardian branch, so a guardian who opened their child's stats
 * from Profile, My kids, got 403. The shared rule,
 * `utils/permissions.ts#teamAccessWhere`, always had all four.
 *
 * The service tests mock Prisma call by call, so they assert what the author
 * wrote, not what the database answers. This suite runs the real query.
 *
 * COVERAGE SHAPE, as in `league-access.db.test.ts`: one fixture user per
 * branch, each qualifying through EXACTLY ONE of them, so a dropped branch
 * fails a test; plus the negatives, so a branch that is too wide fails one too.
 *
 *     staff | member | league admin | guardian of a member | the player
 *
 * Every row is named with a per-run id and removed by that id, never by a list
 * of ids collected along the way: a test that throws early still cleans up.
 */

jest.unmock('../../src/models');

import { randomUUID } from 'node:crypto';
import prisma from '../../src/models';
import { StatsService } from '../../src/services/stats-service';
import { ForbiddenError } from '../../src/utils/errors';

const RUN = randomUUID().slice(0, 8);

jest.setTimeout(30000);

const users: Record<string, string> = {};
const teams: Record<string, string> = {};

async function mkUser(key: string, role: 'PLAYER' | 'COACH' | 'PARENT' | 'ADMIN'): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${key}-${RUN}`, email: `${key}.${RUN}@example.test`, role },
    select: { id: true },
  });
  users[key] = user.id;
  return user.id;
}

async function mkOrg(key: string): Promise<{ leagueId: string; teamId: string; roleId: string }> {
  const league = await prisma.league.create({
    data: { name: `ZZ-Stats-${key}-${RUN}` },
    select: { id: true },
  });
  const season = await prisma.season.create({
    data: { leagueId: league.id, name: `S-${RUN}`, isActive: true },
    select: { id: true },
  });
  const team = await prisma.team.create({
    data: { name: `Team-${key}-${RUN}`, season: { connect: { id: season.id } }, lineage: { create: {} } },
    select: { id: true },
  });
  const role = await prisma.teamRole.create({
    data: { teamId: team.id, type: 'TEAM_MANAGER', name: 'Team Manager', canViewStats: true },
    select: { id: true },
  });
  teams[key] = team.id;
  return { leagueId: league.id, teamId: team.id, roleId: role.id };
}

async function removeEverything(): Promise<void> {
  const runTeams = await prisma.team.findMany({
    where: { name: { endsWith: `-${RUN}` } },
    select: { lineageId: true },
  });
  // Leagues cascade to seasons, teams, roles, staff and members.
  await prisma.league.deleteMany({ where: { name: { endsWith: `-${RUN}` } } });
  await prisma.teamLineage.deleteMany({ where: { id: { in: runTeams.map((t) => t.lineageId) } } });
  // Users cascade to their guardian links.
  await prisma.user.deleteMany({ where: { email: { endsWith: `.${RUN}@example.test` } } });
}

const teamIdsOf = (result: { teams: { teamId: string }[] }): string[] =>
  result.teams.map((t) => t.teamId).sort();

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      'This suite needs a real Postgres. Start one and apply migrations:\n' +
        '  docker-compose up -d && cd backend && npx prisma migrate deploy\n' +
        `DATABASE_URL=${process.env.DATABASE_URL ?? '(unset)'}`,
      { cause: err }
    );
  }

  const a = await mkOrg('a');
  const b = await mkOrg('b');

  // The players whose stats are read.
  await mkUser('child', 'PLAYER'); // on team A only
  await mkUser('twoTeams', 'PLAYER'); // on team A and team B
  await mkUser('otherChild', 'PLAYER'); // on team B only
  await prisma.teamMember.createMany({
    data: [
      { teamId: a.teamId, playerId: users.child },
      { teamId: a.teamId, playerId: users.twoTeams },
      { teamId: b.teamId, playerId: users.twoTeams },
      { teamId: b.teamId, playerId: users.otherChild },
    ],
  });

  // One caller per branch, each with access to team A through that branch only.
  await mkUser('staffOnly', 'COACH');
  await prisma.teamStaff.create({ data: { teamId: a.teamId, userId: users.staffOnly, roleId: a.roleId } });

  await mkUser('memberOnly', 'PLAYER');
  await prisma.teamMember.create({ data: { teamId: a.teamId, playerId: users.memberOnly } });

  await mkUser('adminOnly', 'COACH');
  await prisma.leagueAdmin.create({ data: { leagueId: a.leagueId, userId: users.adminOnly } });

  await mkUser('guardianOnly', 'PARENT');
  await prisma.guardian.create({
    data: { parentId: users.guardianOnly, childId: users.child, relationship: 'MOTHER', isPrimary: true },
  });

  await mkUser('systemAdmin', 'ADMIN');

  // Callers who must be refused for the child on team A.
  await mkUser('stranger', 'COACH');
  await mkUser('guardianOfOther', 'PARENT'); // guardian of a child on team B
  await prisma.guardian.create({
    data: { parentId: users.guardianOfOther, childId: users.otherChild, relationship: 'FATHER', isPrimary: true },
  });
});

afterAll(async () => {
  await removeEverything();
  await prisma.$disconnect();
});

describe('who may read a player\'s overall stats', () => {
  describe('each branch grants access on its own', () => {
    it.each(['staffOnly', 'memberOnly', 'adminOnly', 'systemAdmin'])('%s reads the child on team A', async (caller) => {
      const result = await StatsService.getPlayerOverallStats(users.child, users[caller]);

      expect(result.player.id).toBe(users.child);
      expect(teamIdsOf(result)).toEqual([teams.a]);
    });

    it('the player reads their own stats', async () => {
      const result = await StatsService.getPlayerOverallStats(users.child, users.child);

      expect(teamIdsOf(result)).toEqual([teams.a]);
    });

    // The branch that was missing (#589).
    it('a guardian reads their child', async () => {
      const result = await StatsService.getPlayerOverallStats(users.child, users.guardianOnly);

      expect(result.player.id).toBe(users.child);
      expect(teamIdsOf(result)).toEqual([teams.a]);
    });
  });

  describe('access stops at the teams the caller can read', () => {
    it('a guardian reads a teammate of their child, on the shared team only', async () => {
      // A guardian has the member read set on the child's team (parent-role
      // spec), and the teammate also plays on team B, which the guardian
      // has no link to.
      const result = await StatsService.getPlayerOverallStats(users.twoTeams, users.guardianOnly);

      expect(teamIdsOf(result)).toEqual([teams.a]);
    });

    it('staff on team A read a two-team player on team A only', async () => {
      const result = await StatsService.getPlayerOverallStats(users.twoTeams, users.staffOnly);

      expect(teamIdsOf(result)).toEqual([teams.a]);
    });

    it('a system admin reads both teams', async () => {
      const result = await StatsService.getPlayerOverallStats(users.twoTeams, users.systemAdmin);

      expect(teamIdsOf(result)).toEqual([teams.a, teams.b].sort());
    });
  });

  describe('everyone else is refused', () => {
    it.each(['stranger', 'guardianOfOther'])('%s cannot read the child on team A', async (caller) => {
      await expect(StatsService.getPlayerOverallStats(users.child, users[caller])).rejects.toThrow(ForbiddenError);
    });

    it('a guardian cannot read a player on a team their child is not on', async () => {
      await expect(
        StatsService.getPlayerOverallStats(users.otherChild, users.guardianOnly)
      ).rejects.toThrow(ForbiddenError);
    });

    it('a guardian of a child on team B reads that child, and nothing on team A', async () => {
      const own = await StatsService.getPlayerOverallStats(users.otherChild, users.guardianOfOther);
      expect(teamIdsOf(own)).toEqual([teams.b]);

      const twoTeams = await StatsService.getPlayerOverallStats(users.twoTeams, users.guardianOfOther);
      expect(teamIdsOf(twoTeams)).toEqual([teams.b]);
    });
  });
});
