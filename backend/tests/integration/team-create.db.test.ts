/**
 * REAL DATABASE test: `TeamService.createTeam` and personal-league provisioning (#765).
 *
 * A team create with no `seasonId` provisions the caller's personal league,
 * its LeagueAdmin row and the current-year season inside the same transaction
 * as the team, its three default roles and the caller's Head Coach row. The
 * transaction starts with `SELECT ... FOR UPDATE` on the caller's own User
 * row; `resolvePersonalSeasonId` documents that lock, not a P2002 retry, as
 * what keeps two creates by one caller from colliding on
 * `League.personalOwnerId`.
 *
 * The service tests run all of this against the shared Prisma mock, where
 * `$transaction` just invokes the callback and `$queryRaw` resolves whatever
 * its SQL says. This suite runs the real service against Postgres:
 *
 * - a first create writes the full row set;
 * - a second create reuses the league and season;
 * - concurrent first creates by one caller both succeed with one league;
 * - the User-row lock holds back a create by the caller whose row is locked,
 *   before it provisions anything, and does not hold back anyone else;
 * - the lock serializes the in-transaction tier team-cap re-check;
 * - a create that fails after every row is written leaves none behind.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { PaymentRequiredError } from '../../src/utils/errors';
import * as permissions from '../../src/utils/permissions';
import { TeamService } from '../../src/services/team-service';
import { DbFixtures } from '../support/db-fixtures';
import { backendPid, PRISMA_TRANSACTION_TIMEOUT_MS, track, waitForBlockedBy } from '../support/db-locks';
import { withFiniteFreeTeamLimit } from '../helpers';

jest.setTimeout(60000);

/** Fresh-user rounds of the concurrent-create race; each round races once. */
const RACE_ROUNDS = 5;

const fx = new DbFixtures(prisma, 'TeamCreate');

/** Team names carry the run id so `cleanup()` finds them by pattern too. */
const teamName = (key: string): string => `${key}-${fx.run}`;

interface PersonalRows {
  leagues: { id: string; name: string }[];
  leagueAdmins: { leagueId: string; userId: string }[];
  seasons: { id: string; name: string; isActive: boolean }[];
  teams: { id: string; name: string; seasonId: string; lineageId: string }[];
}

/** Everything a user's personal league holds, read back from the database. */
async function personalRows(userId: string): Promise<PersonalRows> {
  const leagues = await prisma.league.findMany({
    where: { personalOwnerId: userId },
    select: { id: true, name: true },
  });
  const leagueIds = leagues.map((league) => league.id);
  const [leagueAdmins, seasons, teams] = await Promise.all([
    prisma.leagueAdmin.findMany({
      where: { leagueId: { in: leagueIds } },
      select: { leagueId: true, userId: true },
    }),
    prisma.season.findMany({
      where: { leagueId: { in: leagueIds } },
      select: { id: true, name: true, isActive: true },
    }),
    prisma.team.findMany({
      where: { season: { leagueId: { in: leagueIds } } },
      select: { id: true, name: true, seasonId: true, lineageId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { leagues, leagueAdmins, seasons, teams };
}

/** The holder's budget: well under the 5 s the blocked create's own transaction gets. */
const HOLDER_TIMEOUT_MS = 3000;
if (HOLDER_TIMEOUT_MS >= PRISMA_TRANSACTION_TIMEOUT_MS) {
  throw new Error('The lock holder must commit before the blocked transaction times out');
}

/** Tables `createTeam` writes; a backend waiting before provisioning holds no lock on any. */
const WRITTEN_TABLES = ['League', 'LeagueAdmin', 'Season', 'TeamLineage', 'Team', 'TeamRole', 'TeamStaff'];

beforeAll(async () => {
  await fx.requireDatabase();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('TeamService.createTeam against Postgres (#765)', () => {
  it('provisions the full row set on a first create with no seasonId', async () => {
    const coach = await fx.user('first', 'COACH');

    const team = await TeamService.createTeam({ name: teamName('first') }, coach);

    const rows = await personalRows(coach);
    expect(rows.leagues).toHaveLength(1);
    expect(rows.leagueAdmins).toEqual([{ leagueId: rows.leagues[0].id, userId: coach }]);
    expect(rows.seasons).toEqual([
      { id: expect.any(String), name: String(new Date().getFullYear()), isActive: true },
    ]);
    expect(rows.teams).toEqual([
      { id: team!.id, name: teamName('first'), seasonId: rows.seasons[0].id, lineageId: expect.any(String) },
    ]);

    // A fresh lineage that this team alone belongs to.
    expect(await prisma.team.count({ where: { lineageId: rows.teams[0].lineageId } })).toBe(1);

    const roles = await prisma.teamRole.findMany({
      where: { teamId: team!.id },
      select: { id: true, type: true },
    });
    expect(roles.map((role) => role.type).sort()).toEqual(
      ['ASSISTANT_COACH', 'HEAD_COACH', 'TEAM_MANAGER'].sort()
    );

    const staff = await prisma.teamStaff.findMany({
      where: { teamId: team!.id },
      select: { userId: true, role: { select: { type: true } } },
    });
    expect(staff).toEqual([{ userId: coach, role: { type: 'HEAD_COACH' } }]);
  });

  it('reuses the personal league and season on a second create', async () => {
    const coach = await fx.user('second', 'COACH');

    await TeamService.createTeam({ name: teamName('second-a') }, coach);
    const before = await personalRows(coach);
    await TeamService.createTeam({ name: teamName('second-b') }, coach);
    const after = await personalRows(coach);

    expect(after.leagues).toEqual(before.leagues);
    expect(after.leagueAdmins).toEqual(before.leagueAdmins);
    expect(after.seasons).toEqual(before.seasons);
    expect(after.teams.map((team) => team.name)).toEqual([teamName('second-a'), teamName('second-b')]);
    expect(new Set(after.teams.map((team) => team.seasonId))).toEqual(new Set([before.seasons[0].id]));
    expect(new Set(after.teams.map((team) => team.lineageId)).size).toBe(2);
  });

  it('two concurrent first creates by one caller both succeed and share one personal league', async () => {
    for (let round = 1; round <= RACE_ROUNDS; round++) {
      const coach = await fx.user(`race${round}`, 'COACH');

      const outcomes = await Promise.allSettled([
        TeamService.createTeam({ name: teamName(`race${round}-a`) }, coach),
        TeamService.createTeam({ name: teamName(`race${round}-b`) }, coach),
      ]);

      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect({ round, rejected: rejected.map((o) => String(o.reason)) }).toEqual({ round, rejected: [] });

      const rows = await personalRows(coach);
      expect({ round, leagues: rows.leagues.length, seasons: rows.seasons.length }).toEqual({
        round,
        leagues: 1,
        seasons: 1,
      });
      expect(rows.leagueAdmins).toHaveLength(1);
      expect(rows.teams).toHaveLength(2);
    }
  });

  it("holds back a create at its first statement while the caller's User row is locked, and only that caller's", async () => {
    const locked = await fx.user('locked', 'COACH');
    const free = await fx.user('free', 'COACH');
    let lockedCreate: ReturnType<typeof track> | undefined;

    // FOR NO KEY UPDATE, not FOR UPDATE: it conflicts with createTeam's
    // explicit FOR UPDATE but not with the KEY SHARE locks that the League
    // and TeamStaff foreign keys take on the User row. A FOR UPDATE here would
    // hold the create back at its first insert even with the lock removed.
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${locked} FOR NO KEY UPDATE`;
        const pid = await backendPid(tx);

        lockedCreate = track(TeamService.createTeam({ name: teamName('locked') }, locked));
        lockedCreate.promise.catch(() => undefined); // awaited below

        // Another caller's create is not held back by this caller's lock.
        await TeamService.createTeam({ name: teamName('free') }, free);

        // The locked caller's create waits on this transaction, and it waits
        // before provisioning: the waiting backend holds no lock on any table
        // the create writes. With the FOR UPDATE removed it never waits; moved
        // below `resolvePersonalSeasonId`, it waits holding League and Season.
        const waiting = await waitForBlockedBy(tx, pid, { tables: WRITTEN_TABLES, timeoutMs: 2000 });
        expect(waiting).toEqual([{ relations: [] }]);
        expect(lockedCreate.settled()).toBe(false);
      },
      // The blocked create runs in createTeam's own transaction, which passes
      // no options and so dies with P2028 after Prisma's default 5 s. The
      // holder must commit well inside that, leaving the create time to finish.
      { timeout: HOLDER_TIMEOUT_MS }
    );

    await expect(lockedCreate!.promise).resolves.toMatchObject({ name: teamName('locked') });
    expect((await personalRows(locked)).teams).toHaveLength(1);
    expect((await personalRows(free)).teams).toHaveLength(1);
  });

  describe('with a finite FREE team cap of 1', () => {
    // No tier has a finite cap today (#445); a finite cap is what the lock's
    // other job, the in-transaction re-check, exists for.
    withFiniteFreeTeamLimit(1);

    it('serializes the tier team-cap re-check: two concurrent creates at the cap edge make one team', async () => {
      for (let round = 1; round <= RACE_ROUNDS; round++) {
        const coach = await fx.user(`cap${round}`, 'COACH');

        const outcomes = await Promise.allSettled([
          TeamService.createTeam({ name: teamName(`cap${round}-a`) }, coach),
          TeamService.createTeam({ name: teamName(`cap${round}-b`) }, coach),
        ]);

        const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        expect({ round, fulfilled: outcomes.length - rejected.length }).toEqual({ round, fulfilled: 1 });
        expect(rejected[0].reason).toBeInstanceOf(PaymentRequiredError);
        expect((await personalRows(coach)).teams).toHaveLength(1);
      }
    });
  });

  it('leaves no row behind when the create fails after every row is written', async () => {
    const coach = await fx.user('atomic', 'COACH');
    const realAssignTeamRole = permissions.assignTeamRole;
    let writtenTeamId: string | undefined;

    // Let the real Head Coach row be written inside the transaction, then
    // fail: by then the league, LeagueAdmin, season, lineage, team, roles and
    // staff row all exist in the transaction.
    jest
      .spyOn(permissions, 'assignTeamRole')
      .mockImplementation(async (teamId, userId, roleName, db) => {
        await realAssignTeamRole(teamId, userId, roleName, db);
        writtenTeamId = teamId;
        throw new Error('forced failure after the last write (#765)');
      });

    await expect(TeamService.createTeam({ name: teamName('atomic') }, coach)).rejects.toThrow(
      'forced failure after the last write'
    );

    expect(writtenTeamId).toEqual(expect.any(String));
    expect(await personalRows(coach)).toEqual({ leagues: [], leagueAdmins: [], seasons: [], teams: [] });
    expect(await prisma.team.count({ where: { OR: [{ id: writtenTeamId }, { name: teamName('atomic') }] } })).toBe(0);
    expect(await prisma.teamRole.count({ where: { teamId: writtenTeamId } })).toBe(0);
    expect(await prisma.teamStaff.count({ where: { userId: coach } })).toBe(0);
    expect(await prisma.leagueAdmin.count({ where: { userId: coach } })).toBe(0);
  });
});
