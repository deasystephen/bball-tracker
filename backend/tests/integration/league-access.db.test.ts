/**
 * REAL DATABASE test for the league access predicates (#443).
 *
 * Everything else in this suite mocks Prisma (`tests/setup.ts` mocks
 * `../src/models` globally), which means an ordinary "integration" test here
 * asserts that a `where` object equals the `where` object the author wrote. For
 * a cross-tenant fix that is not evidence: it cannot catch an `OR` where an
 * `AND` was meant, a relation filter that matches a different row set than
 * assumed, or NULL semantics on a nullable column.
 *
 * So this file unmocks Prisma and runs against Postgres. CI already provides
 * one: `.github/workflows/ci.yml` runs a `postgres:15` service, applies
 * `prisma migrate deploy`, and sets `DATABASE_URL` for `npm test`. Locally it
 * uses whatever `DATABASE_URL` points at (docker-compose), so every row it
 * creates is namespaced by a per-run id and removed in `afterAll`.
 *
 * COVERAGE SHAPE. A negative-only test ("org A sees zero of org B") cannot
 * catch a DROPPED branch — delete the `members` branch from the predicate and
 * such a test still passes, while real users silently lose access.
 * Under-permissiveness is the main regression risk here. So there is one
 * fixture user per branch, each qualifying through EXACTLY ONE of them:
 *
 *     league admin | personal owner | staff | member | guardian-of-member
 *
 * plus the cross-tenant negatives, with and without a `search` filter.
 */

jest.unmock('../../src/models');

import { randomUUID } from 'node:crypto';
import prisma from '../../src/models';
import {
  getReadableLeagueIds,
  canReadLeague,
  canWriteLeague,
} from '../../src/utils/permissions';
import { LeagueService } from '../../src/services/league-service';

const RUN = randomUUID().slice(0, 8);
const LEAGUE_A = `ZZ-OrgA-${RUN}`;
const LEAGUE_B = `ZZ-OrgB-${RUN}`;
const LEAGUE_P = `ZZ-Personal-${RUN}`;

jest.setTimeout(30000);

type Ids = Record<string, string>;
const users: Ids = {};
const leagues: Ids = {};

async function mkUser(key: string, role: 'PLAYER' | 'COACH' | 'PARENT' | 'ADMIN'): Promise<string> {
  const u = await prisma.user.create({
    data: { name: `${key}-${RUN}`, email: `${key}.${RUN}@example.test`, role },
    select: { id: true },
  });
  users[key] = u.id;
  return u.id;
}

beforeAll(async () => {
  // Fail with something actionable rather than a raw Prisma error if there is
  // no database. Never skip: a silently skipped test is worse than none for a
  // cross-tenant boundary.
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

  // --- Org A: a league with one season and one team -------------------------
  const la = await prisma.league.create({ data: { name: LEAGUE_A }, select: { id: true } });
  leagues.a = la.id;
  const sa = await prisma.season.create({
    data: { leagueId: la.id, name: `S-${RUN}`, isActive: true },
    select: { id: true },
  });
  const ta = await prisma.team.create({
    data: { name: `TeamA-${RUN}`, seasonId: sa.id },
    select: { id: true },
  });
  const role = await prisma.teamRole.create({
    data: { teamId: ta.id, type: 'HEAD_COACH', name: 'Head Coach', canManageTeam: true },
    select: { id: true },
  });

  // --- Org B: a completely separate league ---------------------------------
  const lb = await prisma.league.create({ data: { name: LEAGUE_B }, select: { id: true } });
  leagues.b = lb.id;
  const sb = await prisma.season.create({
    data: { leagueId: lb.id, name: `S-${RUN}`, isActive: true },
    select: { id: true },
  });
  const tb = await prisma.team.create({
    data: { name: `TeamB-${RUN}`, seasonId: sb.id },
    select: { id: true },
  });
  const roleB = await prisma.teamRole.create({
    data: { teamId: tb.id, type: 'HEAD_COACH', name: 'Head Coach', canManageTeam: true },
    select: { id: true },
  });

  // --- One user per access branch, each qualifying via exactly one ---------
  await mkUser('adminOnly', 'COACH');
  await prisma.leagueAdmin.create({ data: { leagueId: la.id, userId: users.adminOnly } });

  await mkUser('ownerOnly', 'COACH');
  const lp = await prisma.league.create({
    data: { name: LEAGUE_P, personalOwnerId: users.ownerOnly },
    select: { id: true },
  });
  leagues.p = lp.id;

  await mkUser('staffOnly', 'COACH');
  await prisma.teamStaff.create({
    data: { teamId: ta.id, userId: users.staffOnly, roleId: role.id },
  });

  await mkUser('memberOnly', 'PLAYER');
  await prisma.teamMember.create({ data: { teamId: ta.id, playerId: users.memberOnly } });

  await mkUser('childMember', 'PLAYER');
  await prisma.teamMember.create({ data: { teamId: ta.id, playerId: users.childMember } });
  await mkUser('guardianOnly', 'PARENT');
  await prisma.guardian.create({
    data: {
      parentId: users.guardianOnly,
      childId: users.childMember,
      relationship: 'MOTHER',
      isPrimary: true,
    },
  });

  // Org B's coach, for the reverse direction.
  await mkUser('orgBStaff', 'COACH');
  await prisma.teamStaff.create({
    data: { teamId: tb.id, userId: users.orgBStaff, roleId: roleB.id },
  });

  // Affiliated with nothing at all.
  await mkUser('outsider', 'COACH');
});

afterAll(async () => {
  // League deletes cascade to seasons -> teams -> staff/members/roles.
  await prisma.league.deleteMany({ where: { name: { in: [LEAGUE_A, LEAGUE_B, LEAGUE_P] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.$disconnect();
});

describe('league access against a real database (#443)', () => {
  describe('every read branch grants access (catches a DROPPED branch)', () => {
    it.each([
      ['league admin', 'adminOnly'],
      ['staff of a team in it', 'staffOnly'],
      ['member of a team in it', 'memberOnly'],
      ['guardian of a member', 'guardianOnly'],
    ])('%s can read org A', async (_label, key) => {
      const ids = await getReadableLeagueIds(users[key]);

      expect(ids).toContain(leagues.a);
      await expect(canReadLeague(users[key], leagues.a)).resolves.toBe(true);
    });

    it('personal owner can read their own container', async () => {
      const ids = await getReadableLeagueIds(users.ownerOnly);

      expect(ids).toContain(leagues.p);
      await expect(canReadLeague(users.ownerOnly, leagues.p)).resolves.toBe(true);
    });
  });

  describe('cross-tenant isolation', () => {
    it.each([['adminOnly'], ['staffOnly'], ['memberOnly'], ['guardianOnly'], ['ownerOnly']])(
      '%s sees none of org B',
      async (key) => {
        const ids = await getReadableLeagueIds(users[key]);

        expect(ids).not.toContain(leagues.b);
        await expect(canReadLeague(users[key], leagues.b)).resolves.toBe(false);
      }
    );

    it("org B's coach sees none of org A", async () => {
      const ids = await getReadableLeagueIds(users.orgBStaff);

      expect(ids).toContain(leagues.b);
      expect(ids).not.toContain(leagues.a);
    });

    it('an unaffiliated user sees nothing at all', async () => {
      await expect(getReadableLeagueIds(users.outsider)).resolves.toEqual([]);
      await expect(canReadLeague(users.outsider, leagues.a)).resolves.toBe(false);
    });
  });

  describe('write access is narrower than read access', () => {
    it.each([
      ['league admin', 'adminOnly', true],
      ['personal owner', 'ownerOnly', true],
      ['staff', 'staffOnly', true],
      // The load-bearing pair: a member or guardian inside somebody's league
      // must never be able to plant a team in it.
      ['member', 'memberOnly', false],
      ['guardian', 'guardianOnly', false],
    ])('%s -> canWriteLeague %s', async (_label, key, expected) => {
      const target = key === 'ownerOnly' ? leagues.p : leagues.a;

      await expect(canWriteLeague(users[key], target)).resolves.toBe(expected);
    });
  });

  describe('LeagueService.listLeagues end to end', () => {
    it('returns only the caller org, with a matching total', async () => {
      const res = await LeagueService.listLeagues(
        { limit: 100, offset: 0 },
        { id: users.staffOnly, role: 'COACH' }
      );

      const names = res.leagues.map((l) => l.name);
      expect(names).toContain(LEAGUE_A);
      expect(names).not.toContain(LEAGUE_B);
      expect(res.total).toBe(res.leagues.length);
    });

    // search must not widen the set: it is ANDed with the access clause.
    it('search cannot be used as a scoping bypass', async () => {
      const res = await LeagueService.listLeagues(
        { search: `ZZ-Org`, limit: 100, offset: 0 },
        { id: users.staffOnly, role: 'COACH' }
      );

      const names = res.leagues.map((l) => l.name);
      expect(names).toContain(LEAGUE_A);
      expect(names).not.toContain(LEAGUE_B);
    });

    it('an unaffiliated caller gets an empty page', async () => {
      const res = await LeagueService.listLeagues(
        { limit: 100, offset: 0 },
        { id: users.outsider, role: 'COACH' }
      );

      expect(res).toEqual({ leagues: [], total: 0, limit: 100, offset: 0 });
    });

    it('hides personal leagues from an ADMIN by default and reveals them on request', async () => {
      const admin = { id: users.adminOnly, role: 'ADMIN' };

      const hidden = await LeagueService.listLeagues({ limit: 200, offset: 0 }, admin);
      expect(hidden.leagues.map((l) => l.name)).not.toContain(LEAGUE_P);

      const shown = await LeagueService.listLeagues(
        { includePersonal: true, limit: 200, offset: 0 },
        admin
      );
      const personal = shown.leagues.find((l) => l.name === LEAGUE_P);
      expect(personal).toBeDefined();
      expect(personal!.isPersonal).toBe(true);
      expect(personal).not.toHaveProperty('personalOwnerId');
    });
  });
});
