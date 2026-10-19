/**
 * REAL DATABASE test: one staff role per user per team (#463).
 *
 * Migration `20261018120000_team_staff_single_role` replaced the unique index
 * on `TeamStaff [teamId, userId, roleId]` with one on `[teamId, userId]`,
 * after deleting every extra row of a user who held several roles on one team.
 * Mocked Prisma can see neither the index nor the delete. This suite checks:
 *
 * - Postgres refuses a second role for the same user on the same team, under
 *   the index name `TeamService.addStaffMember` maps to its 400;
 * - the migration's DELETE block keeps, per (team, user), the row that grants
 *   the most of the old union: most flags, then role type (HEAD_COACH >
 *   ASSISTANT_COACH > TEAM_MANAGER > CUSTOM), then the oldest, then the
 *   lowest id, and touches nothing else. It runs against a session-local TEMP copy of `TeamStaff`, which
 *   shadows the real table inside one transaction that is rolled back, so the
 *   shared database's index is never dropped;
 * - the last-head-coach guard holds on real rows: the sole head coach can be
 *   neither demoted nor removed until a second user holds HEAD_COACH, and two
 *   concurrent removals (or a removal and a demotion, or a removal and the
 *   other head coach's account deletion) of a team's two head coaches leave
 *   one, because every one of them runs behind the team row lock.
 */

jest.unmock('../../src/models');

import { readFileSync } from 'fs';
import path from 'path';
import { Prisma, TeamRoleType } from '@prisma/client';
import prisma from '../../src/models';
import { TeamService } from '../../src/services/team-service';
import { AccountService } from '../../src/services/account-service';
import { getTeamPermissions } from '../../src/utils/permissions';
import { DbFixtures, Org } from '../support/db-fixtures';
import { classifyDbError } from '../../src/models/pool-config';
import { dbBusyOutcome } from '../../src/utils/db-busy';
import { TEAM_LOCK_TIMEOUT_MS } from '../../src/utils/lock-timeout';
import { PRISMA_TRANSACTION_TIMEOUT_MS } from '../support/db-locks';

jest.setTimeout(60000);

const MIGRATION = path.resolve(
  __dirname,
  '../../prisma/migrations/20261018120000_team_staff_single_role/migration.sql'
);

/** The migration's DELETE block (a `DO $$ … $$`), exactly as it ships, between its sentinel lines. */
function migrationDelete(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const begin = sql.indexOf('-- BEGIN DELETE\n');
  const end = sql.indexOf('-- END DELETE');
  if (begin < 0 || end < begin) throw new Error('BEGIN/END DELETE sentinels not found in the migration');
  return sql.slice(begin + '-- BEGIN DELETE\n'.length, end).trim();
}

const fx = new DbFixtures(prisma, 'StaffSingleRole');
let org: Org;
const roles = {} as Record<TeamRoleType | 'CUSTOM_FEW' | 'CUSTOM_MANY' | 'CUSTOM_MANY_2', string>;

/** Adds a role to a fixture team beside its HEAD_COACH one, named with the run id. */
async function addRole(
  type: TeamRoleType,
  flags: Partial<Record<string, boolean>>,
  label: string = type,
  teamId: string = org.teamId
): Promise<string> {
  const role = await prisma.teamRole.create({
    data: {
      teamId,
      type,
      name: `${label}-${fx.run}`,
      canManageTeam: false,
      canManageRoster: false,
      canTrackStats: false,
      canViewStats: true,
      canShareStats: false,
      ...flags,
    },
    select: { id: true },
  });
  return role.id;
}

beforeAll(async () => {
  await fx.requireDatabase();
  org = await fx.org('team');
  roles.HEAD_COACH = org.roleId;
  roles.ASSISTANT_COACH = await addRole('ASSISTANT_COACH', {
    canManageTeam: true,
    canManageRoster: true,
    canTrackStats: true,
    canShareStats: true,
  });
  roles.TEAM_MANAGER = await addRole('TEAM_MANAGER', { canTrackStats: true, canShareStats: true });
  // CUSTOM roles: viewStats is on by default, so FEW has 2 flags and MANY has 4.
  roles.CUSTOM_FEW = await addRole('CUSTOM', { canTrackStats: true }, 'CUSTOM_FEW');
  roles.CUSTOM_MANY = await addRole(
    'CUSTOM',
    { canTrackStats: true, canShareStats: true, canManageRoster: true },
    'CUSTOM_MANY'
  );
  roles.CUSTOM_MANY_2 = await addRole(
    'CUSTOM',
    { canTrackStats: true, canShareStats: true, canManageTeam: true },
    'CUSTOM_MANY_2'
  );
  await fx.user('head', 'COACH');
  await fx.user('second', 'COACH');
  await fx.user('manager', 'COACH');
  await fx.user('custom', 'COACH');
  await fx.user('tie', 'COACH');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('TeamStaff_teamId_userId_key (#463)', () => {
  it('refuses a second role for the same user on the same team, naming the index the service maps', async () => {
    await fx.staff(fx.users.manager, org, roles.TEAM_MANAGER);

    const err = await prisma.teamStaff
      .create({ data: { teamId: org.teamId, userId: fx.users.manager, roleId: roles.ASSISTANT_COACH } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(JSON.stringify((err as Prisma.PrismaClientKnownRequestError).meta)).toContain(
      'TeamStaff_teamId_userId_key'
    );
    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: fx.users.manager } })).toBe(1);
  });

  it('getTeamPermissions returns the one row\'s role flags', async () => {
    await expect(getTeamPermissions(fx.users.manager, org.teamId)).resolves.toEqual({
      canManageTeam: false,
      canManageRoster: false,
      canTrackStats: true,
      canViewStats: true,
      canShareStats: true,
    });
  });
});

describe('the migration DELETE keeps the most privileged row (#463)', () => {
  const ROLLBACK = new Error('rollback: the temp-table rehearsal never commits');

  it('keeps exactly the rows the survivor rule names', async () => {
    const u = fx.users;
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    const at = (minutes: number): Date => new Date(t0 + minutes * 60_000);
    const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    // [id, userId, roleId, createdAt]
    const rows: [string, string, string, Date][] = [
      // head: HEAD_COACH is the NEWEST of three rows and still survives.
      [id(1), u.head, roles.TEAM_MANAGER, at(0)],
      [id(2), u.head, roles.ASSISTANT_COACH, at(1)],
      [id(3), u.head, roles.HEAD_COACH, at(2)],
      // second: TEAM_MANAGER first, ASSISTANT_COACH later (the #727 race). The
      // union granted manageTeam/manageRoster; the newer assistant row survives.
      [id(4), u.second, roles.TEAM_MANAGER, at(3)],
      [id(5), u.second, roles.ASSISTANT_COACH, at(5)],
      // manager: a CUSTOM role with 4 flags (canManageRoster among them)
      // outranks a TEAM_MANAGER row with 3: flags come before role type.
      [id(6), u.manager, roles.CUSTOM_MANY, at(5)],
      [id(7), u.manager, roles.TEAM_MANAGER, at(4)],
      // custom: two CUSTOM roles; more flags beats older.
      [id(8), u.custom, roles.CUSTOM_FEW, at(0)],
      [id(9), u.custom, roles.CUSTOM_MANY, at(6)],
      // tie: same type, same flag count, same createdAt; the lowest id survives.
      [id(11), u.tie, roles.CUSTOM_MANY, at(7)],
      [id(10), u.tie, roles.CUSTOM_MANY_2, at(7)],
    ];

    let survivors: { id: string; userId: string }[] = [];
    let before = -1;
    let after = -1;
    const outcome = await prisma
      .$transaction(async (tx) => {
        // A TEMP table of the same name shadows public."TeamStaff" for this
        // connection only (pg_temp is searched first), with no unique index,
        // so the multi-role state the migration meets can be built.
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "TeamStaff" (LIKE public."TeamStaff" INCLUDING DEFAULTS) ON COMMIT DROP'
        );
        for (const [rowId, userId, roleId, createdAt] of rows) {
          await tx.$executeRaw`
            INSERT INTO "TeamStaff" ("id", "teamId", "userId", "roleId", "createdAt", "updatedAt")
            VALUES (${rowId}, ${org.teamId}, ${userId}, ${roleId}, ${createdAt}, ${createdAt})`;
        }

        before = (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "TeamStaff"`)[0].n;
        await tx.$executeRawUnsafe(migrationDelete());
        after = (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "TeamStaff"`)[0].n;
        survivors = await tx.$queryRaw<{ id: string; userId: string }[]>`
          SELECT "id", "userId" FROM "TeamStaff" ORDER BY "id"`;
        throw ROLLBACK;
      })
      .catch((e: unknown) => e);

    expect(outcome).toBe(ROLLBACK);
    expect(survivors).toEqual([
      { id: id(3), userId: u.head },
      { id: id(5), userId: u.second },
      { id: id(6), userId: u.manager },
      { id: id(9), userId: u.custom },
      { id: id(10), userId: u.tie },
    ]);
    expect(before).toBe(rows.length);
    expect(after).toBe(survivors.length);
    // The real table was never touched by the rehearsal.
    expect(await prisma.teamStaff.count({ where: { id: { in: rows.map(([rowId]) => rowId) } } })).toBe(0);
  });
});

describe('the last-head-coach guard on single-role rows (#463)', () => {
  const LAST_HEAD = 'Cannot remove the last Head Coach. Assign another Head Coach first.';

  it('refuses to demote or remove the sole head coach until a second user holds HEAD_COACH', async () => {
    const head = fx.users.head;
    const second = fx.users.second;
    await fx.staff(head, org, roles.HEAD_COACH);
    await fx.staff(second, org, roles.ASSISTANT_COACH);

    await expect(
      TeamService.changeStaffRole(org.teamId, head, 'ASSISTANT_COACH', head)
    ).rejects.toThrow(LAST_HEAD);
    await expect(TeamService.removeStaffMember(org.teamId, head, head)).rejects.toThrow(LAST_HEAD);

    // Promote the assistant: the head coach is no longer the last one.
    await TeamService.changeStaffRole(org.teamId, second, 'HEAD_COACH', head);
    const demoted = await TeamService.changeStaffRole(org.teamId, head, 'ASSISTANT_COACH', head);

    expect(demoted.role.type).toBe('ASSISTANT_COACH');
    // Re-roling updated the one row in place; each user still holds exactly one.
    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: head } })).toBe(1);
    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: second } })).toBe(1);

    // And now the second user is the last head coach.
    await expect(TeamService.removeStaffMember(org.teamId, second, second)).rejects.toThrow(LAST_HEAD);
  });
});

describe('concurrent head-coach removals behind the team row lock (#463)', () => {
  const ROUNDS = 4;

  /** A fresh team with two head coaches and an ASSISTANT_COACH role to demote to. */
  async function twoHeadCoaches(round: number): Promise<{ teamId: string; a: string; b: string }> {
    const team = await fx.org(`race-${round}`);
    await addRole('ASSISTANT_COACH', { canManageTeam: true, canManageRoster: true }, 'ASSISTANT_COACH', team.teamId);
    const a = await fx.user(`race-a-${round}`, 'COACH');
    const b = await fx.user(`race-b-${round}`, 'COACH');
    await fx.staff(a, team);
    await fx.staff(b, team);
    return { teamId: team.teamId, a, b };
  }

  async function headCoachCount(teamId: string): Promise<number> {
    return prisma.teamStaff.count({ where: { teamId, role: { type: 'HEAD_COACH' } } });
  }

  it.each(Array.from({ length: ROUNDS }, (_, i) => i))(
    'two self-removals: one succeeds, one is refused, one head coach is left (round %i)',
    async (round) => {
      const { teamId, a, b } = await twoHeadCoaches(round);

      const results = await Promise.allSettled([
        TeamService.removeStaffMember(teamId, a, a),
        TeamService.removeStaffMember(teamId, b, b),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({
        statusCode: 400,
        message: 'Cannot remove the last Head Coach. Assign another Head Coach first.',
      });
      expect(await headCoachCount(teamId)).toBe(1);
    }
  );

  it.each(Array.from({ length: ROUNDS }, (_, i) => ROUNDS + i))(
    'a removal racing a demotion leaves one head coach (round %i)',
    async (round) => {
      const { teamId, a, b } = await twoHeadCoaches(round);

      const results = await Promise.allSettled([
        TeamService.removeStaffMember(teamId, a, a),
        TeamService.changeStaffRole(teamId, b, 'ASSISTANT_COACH', b),
      ]);

      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await headCoachCount(teamId)).toBe(1);
    }
  );

  it.each(Array.from({ length: ROUNDS }, (_, i) => 2 * ROUNDS + i))(
    'a removal racing the other head coach\'s account deletion leaves one head coach (round %i)',
    async (round) => {
      const { teamId, a, b } = await twoHeadCoaches(round);

      const results = await Promise.allSettled([
        TeamService.removeStaffMember(teamId, a, a),
        AccountService.deleteAccount(b, { actorId: b, mode: 'self' }),
      ]);

      // Whichever goes second sees the other's commit and is refused.
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused?.reason).toMatchObject({ statusCode: 400 });
      expect(await headCoachCount(teamId)).toBe(1);
    }
  );
});

describe('bounded lock wait behind the team row lock (#934)', () => {
  /** A fresh team with two head coaches and an ASSISTANT_COACH role to demote to. */
  async function twoHeadCoaches(key: string): Promise<{ teamId: string; a: string; b: string }> {
    const team = await fx.org(`lockwait-${key}`);
    await addRole('ASSISTANT_COACH', { canManageTeam: true, canManageRoster: true }, 'ASSISTANT_COACH', team.teamId);
    const a = await fx.user(`lockwait-a-${key}`, 'COACH');
    const b = await fx.user(`lockwait-b-${key}`, 'COACH');
    await fx.staff(a, team);
    await fx.staff(b, team);
    return { teamId: team.teamId, a, b };
  }

  /**
   * Holds the same lock the service takes (`FOR NO KEY UPDATE` on the team
   * row) for the whole call, so the call must give up on its own: PostgreSQL
   * cancels it at `lock_timeout`, before Prisma's 5 s transaction timeout
   * would have left the statement blocked and the connection pinned.
   */
  async function behindTheLock(teamId: string, call: () => Promise<unknown>): Promise<{ err: unknown; elapsedMs: number }> {
    let err: unknown;
    let elapsedMs = 0;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR NO KEY UPDATE`;
        const startedAt = Date.now();
        err = await call().catch((e: unknown) => e);
        elapsedMs = Date.now() - startedAt;
      },
      { timeout: 15_000 }
    );
    return { err, elapsedMs };
  }

  function expectLockWait503(err: unknown, elapsedMs: number): void {
    // The service lets the database error through; the error handlers map it.
    expect(classifyDbError(err)).toBe('lock_wait');
    expect(dbBusyOutcome(err)?.body).toMatchObject({ code: 'transaction_timeout' });
    expect(elapsedMs).toBeGreaterThanOrEqual(TEAM_LOCK_TIMEOUT_MS - 500);
    expect(elapsedMs).toBeLessThan(PRISMA_TRANSACTION_TIMEOUT_MS);
  }

  it('removeStaffMember stuck behind the lock answers the retryable 503 and removes nothing', async () => {
    const { teamId, a } = await twoHeadCoaches('remove');

    const { err, elapsedMs } = await behindTheLock(teamId, () => TeamService.removeStaffMember(teamId, a, a));

    expectLockWait503(err, elapsedMs);
    expect(await prisma.teamStaff.count({ where: { teamId } })).toBe(2);
  });

  it('changeStaffRole stuck behind the lock answers the retryable 503 and changes nothing', async () => {
    const { teamId, b } = await twoHeadCoaches('change');

    const { err, elapsedMs } = await behindTheLock(teamId, () =>
      TeamService.changeStaffRole(teamId, b, 'ASSISTANT_COACH', b)
    );

    expectLockWait503(err, elapsedMs);
    expect(await prisma.teamStaff.count({ where: { teamId, role: { type: 'HEAD_COACH' } } })).toBe(2);
  });
});
