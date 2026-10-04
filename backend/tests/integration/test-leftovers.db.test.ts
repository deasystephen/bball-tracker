/**
 * REAL DATABASE test for the test-row sweep (#584).
 *
 * `removeTestRows` deletes rows. It runs from the seed on a developer's
 * database, next to fixtures the Maestro flows depend on, so the question that
 * matters is what it does NOT delete. This suite plants two kinds of rows:
 *
 * - **Leftovers** of a run that never cleaned up, named the way every
 *   real-database suite names its rows.
 * - **Look-alikes** shaped like seeded fixtures and like ordinary user data,
 *   chosen to sit as close to the patterns as possible without matching.
 *
 * It removes by run id only. The `'all'` scope is READ here
 * (`findTestRows`), never removed: suites run in parallel against one
 * database, and removing everything would delete rows of a suite that is
 * still running.
 */

jest.unmock('../../src/models');

import { randomUUID } from 'node:crypto';
import prisma from '../../src/models';
import {
  assertNotProductionDatabase,
  findTestRows,
  removeTestRows,
  testRowPatterns,
} from '../support/test-leftovers';

/** The run that was interrupted. */
const OLD_RUN = randomUUID().slice(0, 8);
/** Tags the look-alikes. Never a suffix after a hyphen, or they would match. */
const KEEP = randomUUID().slice(0, 8);
/**
 * 8 characters that are upper-case hex whatever KEEP holds. `KEEP.toUpperCase()`
 * is not: an id made of digits only reads the same in both cases, and a name
 * ending in it would rightly match. That is 1 run in 43, and CI hit it.
 */
const UPPER_CASE_SUFFIX = `AB${KEEP.slice(0, 6).toUpperCase()}`;

jest.setTimeout(30000);

const leftover = { users: [] as string[], leagues: [] as string[], teams: [] as string[], lineages: [] as string[] };
const keep = { users: [] as string[], leagues: [] as string[], teams: [] as string[], lineages: [] as string[] };

async function mkOrg(
  leagueName: string,
  teamName: string,
  into: typeof leftover,
  personalOwnerId?: string
): Promise<{ leagueId: string; seasonId: string; teamId: string }> {
  const league = await prisma.league.create({
    data: { name: leagueName, ...(personalOwnerId && { personalOwnerId }) },
    select: { id: true },
  });
  const season = await prisma.season.create({
    data: { leagueId: league.id, name: '2026', isActive: true },
    select: { id: true },
  });
  const team = await prisma.team.create({
    data: { name: teamName, season: { connect: { id: season.id } }, lineage: { create: {} } },
    select: { id: true, lineageId: true },
  });
  into.leagues.push(league.id);
  into.teams.push(team.id);
  into.lineages.push(team.lineageId);
  return { leagueId: league.id, seasonId: season.id, teamId: team.id };
}

async function mkUser(
  into: typeof leftover,
  data: { name: string; email: string | null; role?: 'PLAYER' | 'COACH' | 'PARENT' }
): Promise<string> {
  const user = await prisma.user.create({
    data: { role: 'PLAYER', ...data },
    select: { id: true },
  });
  into.users.push(user.id);
  return user.id;
}

const sorted = (ids: string[]): string[] => [...ids].sort();

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

  // ---------------------------------------------------------------- look-alikes
  const keepOrg = await mkOrg(`Downtown Youth ${KEEP}`, `Lakers ${KEEP}`, keep);
  // Starts like a test league, does not end like one.
  await mkOrg(`ZZ-Top Fan League ${KEEP}`, `Warriors ${KEEP}`, keep);

  // A seeded login: the seed's address domain.
  const keepCoach = await mkUser(keep, {
    name: `Frank Vogel ${KEEP}`,
    email: `frank.vogel.${KEEP}@example.com`,
    role: 'COACH',
  });
  // The run id of the interrupted run, but not a test address.
  await mkUser(keep, { name: `Same Run ${KEEP}`, email: `someone.${OLD_RUN}@example.com` });
  // A test-looking domain that is not the test domain.
  await mkUser(keep, { name: `Near Miss ${KEEP}`, email: `near.${OLD_RUN}@example.testing` });
  // A managed player: no address, a plain name.
  const keepManaged = await mkUser(keep, { name: `Bryce James ${KEEP}`, email: null });
  // No address, a hyphen, and a suffix that is not 8 hex characters.
  await mkUser(keep, { name: `Mary-Kate Olsen-${KEEP.slice(0, 7)}`, email: null });
  await mkUser(keep, { name: `Jean-Luc-${UPPER_CASE_SUFFIX}`, email: null });
  await mkUser(keep, { name: `Dash-${KEEP}x`, email: null });
  // An address AND a name that ends like a run id: the name rule is for rows
  // with no address only.
  await mkUser(keep, { name: `hex-${KEEP}`, email: `hex.${KEEP}@example.com` });

  // ------------------------------------------------------------------ leftovers
  const org = await mkOrg(`ZZ-Old-${OLD_RUN}`, `Old-${OLD_RUN}`, leftover);
  const coach = await mkUser(leftover, {
    name: `coach-${OLD_RUN}`,
    email: `coach.${OLD_RUN}@example.test`,
    role: 'COACH',
  });
  // Suites store mixed case on purpose (email matching tests).
  const player = await mkUser(leftover, { name: `Mixed-${OLD_RUN}`, email: `Mixed.${OLD_RUN}@Example.Test` });
  const managed = await mkUser(leftover, { name: `managed-${OLD_RUN}`, email: null });

  const role = await prisma.teamRole.create({
    data: { teamId: org.teamId, type: 'HEAD_COACH', name: 'Head Coach', canManageTeam: true, canManageRoster: true },
    select: { id: true },
  });
  await prisma.teamStaff.create({ data: { teamId: org.teamId, userId: coach, roleId: role.id } });
  await prisma.teamMember.createMany({
    data: [
      { teamId: org.teamId, playerId: player },
      { teamId: org.teamId, playerId: managed },
    ],
  });
  await prisma.game.create({
    data: { teamId: org.teamId, opponent: `Opp-${OLD_RUN}`, date: new Date('2026-10-01T18:00:00Z') },
  });
  await prisma.guardian.create({
    data: { parentId: coach, childId: managed, relationship: 'FATHER', isPrimary: true },
  });

  // Neither invitation table cascades from its inviter: these block the
  // deletion of the coach unless they go first.
  await prisma.teamInvitation.create({
    data: {
      teamId: org.teamId,
      playerId: player,
      invitedById: coach,
      token: `ti-${OLD_RUN}`,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  await prisma.guardianInvitation.create({
    data: {
      childId: managed,
      teamId: org.teamId,
      invitedEmail: `parent.${OLD_RUN}@example.test`,
      relationship: 'MOTHER',
      invitedById: coach,
      token: `gi-${OLD_RUN}`,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  // The leftover coach invited a player onto a look-alike team: the
  // invitation goes, the team and the player stay.
  await prisma.teamInvitation.create({
    data: {
      teamId: keepOrg.teamId,
      playerId: keepManaged,
      invitedById: coach,
      token: `ti-keep-${OLD_RUN}`,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });

  // A team made through TeamService lands in a personal league, which has no
  // run id in its name. It is found through its owner.
  await mkOrg(`My teams ${KEEP}`, `Personal squad ${KEEP}`, leftover, coach);

  // A test team inside a league that is not a test league.
  const guest = await prisma.team.create({
    data: { name: `Guest-${OLD_RUN}`, season: { connect: { id: keepOrg.seasonId } }, lineage: { create: {} } },
    select: { id: true, lineageId: true },
  });
  leftover.teams.push(guest.id);
  leftover.lineages.push(guest.lineageId);

  // A look-alike staff row on a look-alike team, to show relations survive.
  const keepRole = await prisma.teamRole.create({
    data: { teamId: keepOrg.teamId, type: 'HEAD_COACH', name: 'Head Coach', canManageTeam: true },
    select: { id: true },
  });
  await prisma.teamStaff.create({ data: { teamId: keepOrg.teamId, userId: keepCoach, roleId: keepRole.id } });
  await prisma.teamMember.create({ data: { teamId: keepOrg.teamId, playerId: keepManaged } });
});

afterAll(async () => {
  // Whatever a failed test left of the leftovers.
  await removeTestRows(prisma, { run: OLD_RUN, alsoUserIds: leftover.users });
  // The look-alikes match no pattern, so they are removed by id.
  await prisma.league.deleteMany({ where: { id: { in: keep.leagues } } });
  await prisma.teamLineage.deleteMany({ where: { id: { in: keep.lineages } } });
  await prisma.user.deleteMany({ where: { id: { in: keep.users } } });
  await prisma.$disconnect();
});

describe('findTestRows', () => {
  it('finds the rows of one run, and nothing else', async () => {
    const found = await findTestRows(prisma, { run: OLD_RUN });

    expect(sorted(found.userIds)).toEqual(sorted(leftover.users));
    expect(sorted(found.leagueIds)).toEqual(sorted(leftover.leagues));
    expect(sorted(found.teamIds)).toEqual(sorted(leftover.teams));
    expect(sorted(found.lineageIds)).toEqual(sorted(leftover.lineages));
  });

  it('finds the same rows without being told the run, and no look-alike', async () => {
    const found = await findTestRows(prisma, 'all');

    for (const id of leftover.users) expect(found.userIds).toContain(id);
    for (const id of leftover.leagues) expect(found.leagueIds).toContain(id);
    for (const id of leftover.teams) expect(found.teamIds).toContain(id);

    for (const id of keep.users) expect(found.userIds).not.toContain(id);
    for (const id of keep.leagues) expect(found.leagueIds).not.toContain(id);
    for (const id of keep.teams) expect(found.teamIds).not.toContain(id);
    for (const id of keep.lineages) expect(found.lineageIds).not.toContain(id);
  });

  // The seed runs the 'all' scope on a database that holds the fixtures. On a
  // seeded database this reads the real ones; on CI's it reads whatever the
  // other suites have created. Either way the rule must hold for every row.
  it('never selects an account outside @example.test, whatever the database holds', async () => {
    const found = await findTestRows(prisma, 'all');
    const selected = await prisma.user.findMany({
      where: { id: { in: found.userIds } },
      select: { name: true, email: true, deletedAt: true },
    });

    // Suites run in parallel against one database. A row another suite
    // tombstoned between the two reads above comes back as "Deleted user"
    // with no address; the scan cannot have matched it in that state (a
    // tombstone has no email and no run-suffixed name), so it was a test row
    // when it was selected. Only a row that is still live can be wrong.
    const wronglySelected = selected.filter(({ name, email, deletedAt }) =>
      deletedAt === null &&
      (email === null ? !/-[0-9a-f]{8}$/.test(name) : !email.toLowerCase().endsWith('@example.test'))
    );
    expect(wronglySelected).toEqual([]);

    const seededLogins = await prisma.user.count({
      where: {
        id: { in: found.userIds },
        OR: [{ email: { endsWith: '@example.com' } }, { email: { endsWith: '@bball-tracker.com' } }],
      },
    });
    expect(seededLogins).toBe(0);
  });
});

describe('removeTestRows', () => {
  it('removes the rows of the run, invitations first', async () => {
    const removed = await removeTestRows(prisma, { run: OLD_RUN });

    expect(removed).toEqual({ users: 3, leagues: 2, teams: 3, games: 1, invitations: 3 });

    expect(await prisma.user.count({ where: { id: { in: leftover.users } } })).toBe(0);
    expect(await prisma.league.count({ where: { id: { in: leftover.leagues } } })).toBe(0);
    expect(await prisma.team.count({ where: { id: { in: leftover.teams } } })).toBe(0);
    expect(await prisma.teamLineage.count({ where: { id: { in: leftover.lineages } } })).toBe(0);
    expect(await prisma.game.count({ where: { opponent: `Opp-${OLD_RUN}` } })).toBe(0);
    expect(await prisma.teamInvitation.count({ where: { token: { endsWith: OLD_RUN } } })).toBe(0);
    expect(await prisma.guardianInvitation.count({ where: { token: `gi-${OLD_RUN}` } })).toBe(0);
  });

  it('leaves every look-alike, with its relations', async () => {
    expect(await prisma.user.count({ where: { id: { in: keep.users } } })).toBe(keep.users.length);
    expect(await prisma.league.count({ where: { id: { in: keep.leagues } } })).toBe(keep.leagues.length);
    expect(await prisma.team.count({ where: { id: { in: keep.teams } } })).toBe(keep.teams.length);
    expect(await prisma.teamLineage.count({ where: { id: { in: keep.lineages } } })).toBe(keep.lineages.length);

    expect(await prisma.teamStaff.count({ where: { teamId: { in: keep.teams } } })).toBe(1);
    expect(await prisma.teamMember.count({ where: { teamId: { in: keep.teams } } })).toBe(1);
  });

  it('does nothing the second time', async () => {
    const removed = await removeTestRows(prisma, { run: OLD_RUN });

    expect(removed).toEqual({ users: 0, leagues: 0, teams: 0, games: 0, invitations: 0 });
  });

  it('removes accounts that lost their run id, when it is given their ids', async () => {
    // What account deletion does to a row: no address, a placeholder name.
    const tombstone = await prisma.user.create({
      data: { name: 'Deleted user', email: null, role: 'PLAYER', deletedAt: new Date() },
      select: { id: true },
    });

    const byRunOnly = await findTestRows(prisma, { run: OLD_RUN });
    expect(byRunOnly.userIds).not.toContain(tombstone.id);

    const removed = await removeTestRows(prisma, { run: OLD_RUN, alsoUserIds: [tombstone.id] });
    expect(removed.users).toBe(1);
    expect(await prisma.user.count({ where: { id: tombstone.id } })).toBe(0);
  });
});

describe('the guards', () => {
  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost:5432/app' }],
    ['an RDS host', { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@db.abc.us-east-1.rds.amazonaws.com/app' }],
    ['an RDS host with NODE_ENV unset', { DATABASE_URL: 'postgresql://u:p@DB.ABC.US-EAST-1.RDS.AMAZONAWS.COM/app' }],
  ])('refuse %s', (_label, env) => {
    expect(() => assertNotProductionDatabase(env as NodeJS.ProcessEnv)).toThrow('Refusing to remove test rows');
  });

  it.each([
    ['a local database', { NODE_ENV: 'development', DATABASE_URL: 'postgresql://localhost:5432/bball' }],
    ['the test environment', { NODE_ENV: 'test', DATABASE_URL: 'postgresql://postgres:5432/test' }],
    ['no settings at all', {}],
  ])('allow %s', (_label, env) => {
    expect(() => assertNotProductionDatabase(env as NodeJS.ProcessEnv)).not.toThrow();
  });

  it.each(['', 'abc', 'ABCDEF12', 'abcdef123', "x' OR '1'='1", '.*', 'abcdefg1'])(
    'refuse "%s" as a run id',
    async (run) => {
      expect(() => testRowPatterns({ run })).toThrow('A run id is 8 lower-case hex characters');
      await expect(findTestRows(prisma, { run })).rejects.toThrow('A run id is 8 lower-case hex characters');
    }
  );
});
