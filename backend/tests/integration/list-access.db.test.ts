/**
 * REAL DATABASE test: the caller scoping of `TeamService.listTeams` and
 * `GameService.listGames` (#458).
 *
 * Both lists decide who sees what with `utils/permissions#teamAccessWhere`
 * (staff OR member OR league admin OR guardian of a member). The service
 * suites mock Prisma, so they can only assert that the `where` object equals
 * the one the author wrote; they pass unchanged if the predicate selects the
 * wrong rows. This suite runs the real queries through `tests/support/db-fixtures.ts`.
 *
 * COVERAGE SHAPE, as in `league-access.db.test.ts`: one caller per branch,
 * each qualifying through EXACTLY ONE of them, so a dropped branch fails a
 * test; cross-tenant and same-league negatives, so a branch that is too wide
 * fails one too; and every optional filter combined with the access clause,
 * so a filter can narrow the set but never widen it.
 *
 *     league admin | staff | member | guardian of a member
 *
 * Org A has TWO teams in one season. Staff of A1 must not see A2: the clause
 * is per team, and only the league-admin branch spans a league.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { DbFixtures } from '../support/db-fixtures';
import { TeamService } from '../../src/services/team-service';
import { GameService } from '../../src/services/game-service';
import { ForbiddenError } from '../../src/utils/errors';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'List');
const { users, orgs } = fx;
const games: Record<string, string> = {};

const PAGE = { limit: 100, offset: 0 };

const teamIdsOf = (result: { teams: { id: string }[] }): string[] =>
  result.teams.map((t) => t.id).sort();
const gameIdsOf = (result: { games: { id: string }[] }): string[] =>
  result.games.map((g) => g.id).sort();
const sorted = (ids: string[]): string[] => [...ids].sort();

beforeAll(async () => {
  await fx.requireDatabase();

  // Org A: one league, one season, two teams. Org B: a separate league.
  const a1 = await fx.org('A1');
  const a2 = await fx.org('A2', { league: a1 });
  const b1 = await fx.org('B1');

  // One caller per access branch, each qualifying through exactly one.
  await fx.leagueAdmin(await fx.user('adminOnly', 'COACH'), a1);
  await fx.staff(await fx.user('staffOnly', 'COACH'), a1);
  await fx.member(await fx.user('memberOnly', 'PLAYER'), a1);
  await fx.member(await fx.user('childMember', 'PLAYER'), a1);
  await fx.guardian(await fx.user('guardianOnly', 'PARENT'), users.childMember);

  await fx.staff(await fx.user('orgBStaff', 'COACH'), b1);
  await fx.user('outsider', 'COACH');
  await fx.user('sysadmin', 'ADMIN');

  // Games: two on A1 (one finished, a month ago), one on A2, one on B1.
  games.a1Scheduled = await fx.game(a1, { date: new Date('2030-01-15T18:00:00Z') });
  games.a1Finished = await fx.game(a1, { status: 'FINISHED', date: new Date('2029-12-01T18:00:00Z') });
  games.a2 = await fx.game(a2, { date: new Date('2030-01-16T18:00:00Z') });
  games.b1 = await fx.game(b1, { date: new Date('2030-01-17T18:00:00Z') });
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('TeamService.listTeams against a real database (#458)', () => {
  describe('every access branch grants the team (catches a DROPPED branch)', () => {
    it.each([
      ['league admin', 'adminOnly'],
      ['staff', 'staffOnly'],
      ['member', 'memberOnly'],
      ['guardian of a member', 'guardianOnly'],
    ])('%s sees A1 and not B1, with a matching total', async (_label, key) => {
      const res = await TeamService.listTeams(PAGE, users[key]);

      const ids = teamIdsOf(res);
      expect(ids).toContain(orgs.A1.teamId);
      expect(ids).not.toContain(orgs.B1.teamId);
      expect(res.total).toBe(res.teams.length);
    });
  });

  describe('the clause is per team; only the league-admin branch spans a league', () => {
    it('the league admin sees both teams of org A', async () => {
      const res = await TeamService.listTeams(PAGE, users.adminOnly);

      expect(teamIdsOf(res)).toEqual(sorted([orgs.A1.teamId, orgs.A2.teamId]));
    });

    it.each([['staffOnly'], ['memberOnly'], ['guardianOnly']])(
      '%s sees A1 only, not its sibling A2',
      async (key) => {
        const res = await TeamService.listTeams(PAGE, users[key]);

        expect(teamIdsOf(res)).toEqual([orgs.A1.teamId]);
      }
    );
  });

  describe('cross-tenant isolation', () => {
    it("org B's coach sees B1 only", async () => {
      const res = await TeamService.listTeams(PAGE, users.orgBStaff);

      expect(teamIdsOf(res)).toEqual([orgs.B1.teamId]);
    });

    it('an unaffiliated caller gets an empty page', async () => {
      const res = await TeamService.listTeams(PAGE, users.outsider);

      expect(res).toEqual({ teams: [], total: 0, ...PAGE });
    });

    it('a system ADMIN is unscoped', async () => {
      const [a, b] = await Promise.all([
        TeamService.listTeams({ ...PAGE, leagueId: orgs.A1.leagueId }, users.sysadmin),
        TeamService.listTeams({ ...PAGE, leagueId: orgs.B1.leagueId }, users.sysadmin),
      ]);

      expect(teamIdsOf(a)).toEqual(sorted([orgs.A1.teamId, orgs.A2.teamId]));
      expect(teamIdsOf(b)).toEqual([orgs.B1.teamId]);
    });
  });

  describe('filters are ANDed with the access clause: they narrow, never widen', () => {
    it('leagueId: staff of A1 still sees only A1 in league A', async () => {
      const res = await TeamService.listTeams({ ...PAGE, leagueId: orgs.A1.leagueId }, users.staffOnly);

      expect(teamIdsOf(res)).toEqual([orgs.A1.teamId]);
      expect(res.total).toBe(1);
    });

    it("leagueId: org B's coach asking for league A gets nothing", async () => {
      const res = await TeamService.listTeams({ ...PAGE, leagueId: orgs.A1.leagueId }, users.orgBStaff);

      expect(res).toEqual({ teams: [], total: 0, ...PAGE });
    });

    it('seasonId: the league admin filtered to season A sees both A teams', async () => {
      const res = await TeamService.listTeams({ ...PAGE, seasonId: orgs.A1.seasonId }, users.adminOnly);

      expect(teamIdsOf(res)).toEqual(sorted([orgs.A1.teamId, orgs.A2.teamId]));
    });

    it("seasonId: org B's coach asking for season A gets nothing", async () => {
      const res = await TeamService.listTeams({ ...PAGE, seasonId: orgs.A1.seasonId }, users.orgBStaff);

      expect(res).toEqual({ teams: [], total: 0, ...PAGE });
    });

    it('playerId: a caller with access sees the teams that player is on', async () => {
      const res = await TeamService.listTeams({ ...PAGE, playerId: users.memberOnly }, users.staffOnly);

      expect(teamIdsOf(res)).toEqual([orgs.A1.teamId]);
    });

    it("playerId: naming a player in another org reveals none of that org's teams", async () => {
      const res = await TeamService.listTeams({ ...PAGE, playerId: users.memberOnly }, users.orgBStaff);

      expect(res).toEqual({ teams: [], total: 0, ...PAGE });
    });
  });
});

describe('GameService.listGames against a real database (#458)', () => {
  describe('every access branch grants the games (catches a DROPPED branch)', () => {
    it.each([
      ['league admin', 'adminOnly'],
      ['staff', 'staffOnly'],
      ['member', 'memberOnly'],
      ['guardian of a member', 'guardianOnly'],
    ])("%s sees A1's games and not B1's, with a matching total", async (_label, key) => {
      const res = await GameService.listGames(PAGE, users[key]);

      const ids = gameIdsOf(res);
      expect(ids).toEqual(expect.arrayContaining([games.a1Scheduled, games.a1Finished]));
      expect(ids).not.toContain(games.b1);
      expect(res.total).toBe(res.games.length);
    });
  });

  describe('the clause is per team; only the league-admin branch spans a league', () => {
    it("the league admin sees A2's game too", async () => {
      const res = await GameService.listGames(PAGE, users.adminOnly);

      expect(gameIdsOf(res)).toEqual(sorted([games.a1Scheduled, games.a1Finished, games.a2]));
    });

    it.each([['staffOnly'], ['memberOnly'], ['guardianOnly']])(
      "%s does not see sibling team A2's game",
      async (key) => {
        const res = await GameService.listGames(PAGE, users[key]);

        expect(gameIdsOf(res)).toEqual(sorted([games.a1Scheduled, games.a1Finished]));
      }
    );
  });

  describe('cross-tenant isolation', () => {
    it("org B's coach sees B1's game only", async () => {
      const res = await GameService.listGames(PAGE, users.orgBStaff);

      expect(gameIdsOf(res)).toEqual([games.b1]);
    });

    it('an unaffiliated caller gets an empty page without touching the games table', async () => {
      const res = await GameService.listGames(PAGE, users.outsider);

      expect(res).toEqual({ games: [], total: 0, ...PAGE });
    });

    it('a system ADMIN is unscoped', async () => {
      const res = await GameService.listGames({ ...PAGE, teamId: orgs.B1.teamId }, users.sysadmin);

      expect(gameIdsOf(res)).toEqual([games.b1]);
    });
  });

  describe('teamId is checked against the access set, not merely filtered', () => {
    it('a team the caller may see narrows the list to it', async () => {
      const res = await GameService.listGames({ ...PAGE, teamId: orgs.A1.teamId }, users.adminOnly);

      expect(gameIdsOf(res)).toEqual(sorted([games.a1Scheduled, games.a1Finished]));
      expect(res.total).toBe(2);
    });

    it("another org's team is 403, not an empty page", async () => {
      await expect(
        GameService.listGames({ ...PAGE, teamId: orgs.B1.teamId }, users.staffOnly)
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('a sibling team in the same league is 403 for staff of the other team', async () => {
      await expect(
        GameService.listGames({ ...PAGE, teamId: orgs.A2.teamId }, users.staffOnly)
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('a caller with no teams at all gets the empty page even when naming a team', async () => {
      const res = await GameService.listGames({ ...PAGE, teamId: orgs.A1.teamId }, users.outsider);

      expect(res).toEqual({ games: [], total: 0, ...PAGE });
    });
  });

  describe('status and date filters are ANDed with the access clause', () => {
    it('status narrows within the caller set', async () => {
      const res = await GameService.listGames({ ...PAGE, status: 'FINISHED' }, users.staffOnly);

      expect(gameIdsOf(res)).toEqual([games.a1Finished]);
      expect(res.total).toBe(1);
    });

    it('a date range narrows within the caller set', async () => {
      const res = await GameService.listGames(
        { ...PAGE, startDate: '2030-01-01T00:00:00.000Z', endDate: '2030-01-31T23:59:59.000Z' },
        users.adminOnly
      );

      expect(gameIdsOf(res)).toEqual(sorted([games.a1Scheduled, games.a2]));
    });

    it("a date range that covers another org's game does not reveal it", async () => {
      const res = await GameService.listGames(
        { ...PAGE, startDate: '2030-01-17T00:00:00.000Z', endDate: '2030-01-17T23:59:59.000Z' },
        users.staffOnly
      );

      expect(res.games).toEqual([]);
      expect(res.total).toBe(0);
    });
  });
});
