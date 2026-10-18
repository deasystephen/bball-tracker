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
 * - the migration's DELETE keeps, per (team, user), the most privileged
 *   row: role type (HEAD_COACH > ASSISTANT_COACH > TEAM_MANAGER > CUSTOM),
 *   then flag count, then the oldest, then the lowest id, and touches
 *   nothing else. It runs against a session-local TEMP copy of `TeamStaff`, which
 *   shadows the real table inside one transaction that is rolled back, so the
 *   shared database's index is never dropped;
 * - the last-head-coach guard holds on real rows: the sole head coach can be
 *   neither demoted nor removed until a second user holds HEAD_COACH.
 */

jest.unmock('../../src/models');

import { readFileSync } from 'fs';
import path from 'path';
import { Prisma, TeamRoleType } from '@prisma/client';
import prisma from '../../src/models';
import { TeamService } from '../../src/services/team-service';
import { getTeamPermissions } from '../../src/utils/permissions';
import { DbFixtures, Org } from '../support/db-fixtures';

jest.setTimeout(60000);

const MIGRATION = path.resolve(
  __dirname,
  '../../prisma/migrations/20261018120000_team_staff_single_role/migration.sql'
);

/** The migration's DELETE statement, exactly as it ships, between its sentinel lines. */
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

/** Adds a role to the fixture team beside its HEAD_COACH one, named with the run id. */
async function addRole(
  type: TeamRoleType,
  flags: Partial<Record<string, boolean>>,
  label: string = type
): Promise<string> {
  const role = await prisma.teamRole.create({
    data: {
      teamId: org.teamId,
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
      // manager: TEAM_MANAGER (3 flags) outranks an older CUSTOM role with 4.
      [id(6), u.manager, roles.CUSTOM_MANY, at(0)],
      [id(7), u.manager, roles.TEAM_MANAGER, at(4)],
      // custom: two CUSTOM roles; more flags beats older.
      [id(8), u.custom, roles.CUSTOM_FEW, at(0)],
      [id(9), u.custom, roles.CUSTOM_MANY, at(6)],
      // tie: same type, same flag count, same createdAt; the lowest id survives.
      [id(11), u.tie, roles.CUSTOM_MANY, at(7)],
      [id(10), u.tie, roles.CUSTOM_MANY_2, at(7)],
    ];

    let survivors: { id: string; userId: string }[] = [];
    let deleted = -1;
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

        deleted = await tx.$executeRawUnsafe(migrationDelete());
        survivors = await tx.$queryRaw<{ id: string; userId: string }[]>`
          SELECT "id", "userId" FROM "TeamStaff" ORDER BY "id"`;
        throw ROLLBACK;
      })
      .catch((e: unknown) => e);

    expect(outcome).toBe(ROLLBACK);
    expect(survivors).toEqual([
      { id: id(3), userId: u.head },
      { id: id(5), userId: u.second },
      { id: id(7), userId: u.manager },
      { id: id(9), userId: u.custom },
      { id: id(10), userId: u.tie },
    ]);
    expect(deleted).toBe(rows.length - survivors.length);
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
