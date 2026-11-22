/**
 * Staff invitation follow-ups (#1038) against a REAL Postgres.
 *
 *  - Removing a league admin row cancels the PENDING staff invitations that
 *    admin sent on the league's teams, except where they still manage staff
 *    (a head coach there keeps theirs).
 *  - `POST /teams/:teamId/staff` (`TeamService.addStaffMember`) writes under
 *    the target's `User` row lock: an Add Player adoption that marks the row
 *    managed while the add waits is seen, and the add is refused instead of
 *    leaving a managed record holding a staff role.
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import prisma from '../../src/models';
import { StaffInvitationService } from '../../src/services/staff-invitation-service';
import { LeagueService } from '../../src/services/league-service';
import { TeamService } from '../../src/services/team-service';
import { StaffTargetNeedsInvitationError } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { backendPid, track, waitForBlockedBy } from '../support/db-locks';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'staff-followups');
let sysAdminId: string;

function address(local: string): string {
  return `${local}.${fx.run}@example.test`;
}

async function assistantRole(org: Org): Promise<void> {
  await prisma.teamRole.create({
    data: { teamId: org.teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageRoster: true },
  });
}

async function statusOf(invitationId: string): Promise<string> {
  const row = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitationId }, select: { status: true } });
  return row.status;
}

beforeAll(async () => {
  await fx.requireDatabase();
  sysAdminId = await fx.user('sysadmin', 'ADMIN');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('removing a league admin cancels the staff invitations they can no longer stand behind (#1038)', () => {
  it('cancels them on teams they do not coach, keeps them where they are head coach, leaves other inviters alone', async () => {
    const teamA = await fx.org('lgA');
    const teamB = await fx.org('lgB', { league: teamA });
    await assistantRole(teamA);
    await assistantRole(teamB);
    const adminId = await fx.user('lgadmin', 'COACH');
    await fx.leagueAdmin(adminId, teamA);
    // Head coach of team B as well, so the right on B survives the removal.
    await fx.staff(adminId, teamB);
    const otherHeadId = await fx.user('otherhead', 'COACH');
    await fx.staff(otherHeadId, teamA);

    const onA = await StaffInvitationService.inviteStaff(
      teamA.teamId,
      { email: address('a-invitee'), roleType: 'ASSISTANT_COACH' },
      adminId
    );
    const onB = await StaffInvitationService.inviteStaff(
      teamB.teamId,
      { email: address('b-invitee'), roleType: 'ASSISTANT_COACH' },
      adminId
    );
    const byOther = await StaffInvitationService.inviteStaff(
      teamA.teamId,
      { email: address('o-invitee'), roleType: 'ASSISTANT_COACH' },
      otherHeadId
    );

    await LeagueService.removeLeagueAdmin(teamA.leagueId, adminId, sysAdminId);

    expect(await statusOf(onA.id)).toBe('CANCELLED');
    expect(await statusOf(onB.id)).toBe('PENDING');
    expect(await statusOf(byOther.id)).toBe('PENDING');
    // The pending list the head coach sees is truthful now.
    const pending = await StaffInvitationService.listPendingForTeam(teamA.teamId, otherHeadId);
    expect(pending.map((row) => row.id)).toEqual([byOther.id]);
  });
});

describe('removing a league admin and the same person\'s head-coach row at once (#1038)', () => {
  it('the removal that runs second sees the other and cancels: the team lock serialises them', async () => {
    const org = await fx.org('lgRace');
    await assistantRole(org);
    const adminId = await fx.user('raceadmin', 'COACH');
    await fx.leagueAdmin(adminId, org);
    await fx.staff(adminId, org); // also head coach
    const invitation = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email: address('race-invitee'), roleType: 'ASSISTANT_COACH' },
      adminId
    );

    let removal: ReturnType<typeof track<unknown>> | undefined;
    await prisma.$transaction(
      async (holder) => {
        // What a head-coach removal holds while it deletes the staff row.
        await holder.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${org.teamId} FOR NO KEY UPDATE`;
        const pid = await backendPid(holder);
        removal = track(LeagueService.removeLeagueAdmin(org.leagueId, adminId, sysAdminId));
        removal.promise.catch(() => undefined);
        await waitForBlockedBy(holder, pid, { tables: ['Team'], timeoutMs: 4000, settled: removal });
        await holder.teamStaff.deleteMany({ where: { teamId: org.teamId, userId: adminId } });
      },
      { timeout: 10_000 }
    );

    await expect(removal?.promise).resolves.toEqual({ success: true });
    expect(await statusOf(invitation.id)).toBe('CANCELLED');
  });
});

describe('POST /teams/:teamId/staff by a league admin removed while it waits (#1038)', () => {
  it('re-checks the requester behind the requester\'s user lock and answers 403, with no staff row', async () => {
    const org = await fx.org('reqLock');
    await assistantRole(org);
    const adminId = await fx.user('reqadmin', 'COACH');
    await fx.leagueAdmin(adminId, org);
    const targetId = await fx.user('reqtarget', 'COACH');

    let add: ReturnType<typeof track<unknown>> | undefined;
    await prisma.$transaction(
      async (holder) => {
        // What removeLeagueAdmin holds on the former admin while it deletes the row.
        await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${adminId} FOR NO KEY UPDATE`;
        const pid = await backendPid(holder);
        add = track(TeamService.addStaffMember(org.teamId, { userId: targetId, roleType: 'ASSISTANT_COACH' }, adminId));
        add.promise.catch(() => undefined);
        await waitForBlockedBy(holder, pid, { tables: ['User'], timeoutMs: 4000, settled: add });
        await holder.leagueAdmin.deleteMany({ where: { leagueId: org.leagueId, userId: adminId } });
      },
      { timeout: 10_000 }
    );

    await expect(add?.promise).rejects.toMatchObject({ statusCode: 403 });
    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: targetId } })).toBe(0);
  });
});

describe('POST /teams/:teamId/staff writes under the target user lock (#1038)', () => {
  it('an adoption that marks the row managed while the add waits makes the add a 400, with no staff row', async () => {
    const org = await fx.org('staffLock');
    await assistantRole(org);
    const headId = await fx.user('lockhead', 'COACH');
    await fx.staff(headId, org);
    // An unclaimed, unmanaged row (an Add Player pre-provision that never signed in).
    const targetId = await fx.user('target', 'PLAYER');

    let add: ReturnType<typeof track<unknown>> | undefined;
    await prisma.$transaction(
      async (holder) => {
        // What Add Player's case-2 adoption takes before it marks the row managed.
        await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${targetId} FOR NO KEY UPDATE`;
        const pid = await backendPid(holder);
        add = track(TeamService.addStaffMember(org.teamId, { userId: targetId, roleType: 'ASSISTANT_COACH' }, headId));
        add.promise.catch(() => undefined);
        await waitForBlockedBy(holder, pid, { tables: ['User'], timeoutMs: 4000, settled: add });
        await holder.user.update({ where: { id: targetId, deletedAt: null }, data: { isManaged: true, managedById: headId } });
      },
      { timeout: 10_000 }
    );

    await expect(add?.promise).rejects.toBeInstanceOf(StaffTargetNeedsInvitationError);
    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: targetId } })).toBe(0);
  });

  it('still adds a live, unmanaged account', async () => {
    const org = await fx.org('staffAdd');
    await assistantRole(org);
    const headId = await fx.user('addhead', 'COACH');
    await fx.staff(headId, org);
    const targetId = await fx.user('plain', 'COACH');

    const staff = await TeamService.addStaffMember(org.teamId, { userId: targetId, roleType: 'ASSISTANT_COACH' }, headId);

    expect(staff).toMatchObject({ teamId: org.teamId, userId: targetId, role: { type: 'ASSISTANT_COACH' } });
  });
});
