/**
 * Staff invitations by email (#460) against a REAL Postgres.
 *
 * The mocked API suite (`tests/api/staff-invitations.test.ts`) asserts the
 * `where` objects the service writes. Here the database answers:
 *  - invite time creates no `User` row (the claim-by-email hazard);
 *  - the hand-written partial unique index admits one PENDING row per
 *    team + address and is recognised under the name Prisma 7 reports;
 *  - `emailEquals` keeps a look-alike account (`firstXlast` for a query
 *    `first_last`) out of the list and out of the by-token accept;
 *  - by-token accept creates the account and the staff row with the invited
 *    role, refuses an unclaimed managed record, and two concurrent accepts of
 *    one link end with one account and one staff row;
 *  - decline strips the address; account deletion expires and scrubs.
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import prisma from '../../src/models';
import { StaffInvitationService } from '../../src/services/staff-invitation-service';
import { AccountService } from '../../src/services/account-service';
import { InvitationService } from '../../src/services/invitation-service';
import { TeamService } from '../../src/services/team-service';
import { PlayerService } from '../../src/services/player-service';
import { BadRequestError, SignInRequiredError } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'staff-invite');
let org: Org;
let headCoachId: string;

/** An address in this run's namespace (cleaned up by pattern). */
function address(local: string): string {
  return `${local}.${fx.run}@example.test`;
}

async function tokenOf(invitationId: string): Promise<string> {
  const { token } = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitationId }, select: { token: true } });
  return token;
}

beforeAll(async () => {
  await fx.requireDatabase();
  headCoachId = await fx.user('head', 'COACH');
  org = await fx.org('club');
  await fx.staff(headCoachId, org);
  await prisma.teamRole.create({
    data: { teamId: org.teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageRoster: true, canViewStats: true },
  });
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('StaffInvitationService (real Postgres, #460)', () => {
  it('invites an address with no account without creating a User row, and admits one PENDING row', async () => {
    const email = address('Fresh.Coach');
    const invitation = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email, roleType: 'ASSISTANT_COACH' },
      headCoachId
    );

    expect(invitation).not.toHaveProperty('token');
    expect(invitation.invitedEmail).toBe(email.toLowerCase());
    // The email's From display name is the inviting head coach.
    const { mailer } = jest.requireMock('../../src/services/mailer') as { mailer: { send: jest.Mock } };
    const coach = await prisma.user.findUniqueOrThrow({ where: { id: headCoachId }, select: { name: true } });
    const sendArgs = mailer.send.mock.calls[mailer.send.mock.calls.length - 1][0] as { senderName?: string };
    expect(sendArgs.senderName).toBe(coach.name);
    expect(await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })).toBe(0);

    // A second plain invite answers the dedupe 400.
    await expect(
      StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'ASSISTANT_COACH' }, headCoachId)
    ).rejects.toBeInstanceOf(BadRequestError);

    // The partial index itself refuses a second PENDING row for the pair...
    await expect(
      prisma.staffInvitation.create({
        data: {
          token: `dup-${fx.run}`,
          teamId: org.teamId,
          invitedEmail: email.toLowerCase(),
          recipientHash: 'x',
          roleType: 'ASSISTANT_COACH',
          invitedById: headCoachId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
    // ...and the name it reports is the one the service maps to the 400.
    const err = await prisma.staffInvitation
      .create({
        data: {
          token: `dup2-${fx.run}`,
          teamId: org.teamId,
          invitedEmail: email.toLowerCase(),
          recipientHash: 'x',
          roleType: 'ASSISTANT_COACH',
          invitedById: headCoachId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
      .catch((e: unknown) => e);
    expect(JSON.stringify((err as { meta?: unknown }).meta)).toContain('StaffInvitation_pending_teamId_invitedEmail_key');

    // ...while any number of non-PENDING rows may sit beside it.
    await prisma.staffInvitation.create({
      data: {
        token: `old-${fx.run}`,
        teamId: org.teamId,
        invitedEmail: email.toLowerCase(),
        recipientHash: 'x',
        roleType: 'ASSISTANT_COACH',
        invitedById: headCoachId,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
  });

  it('by-token accept creates the account and the staff row with the invited role', async () => {
    const email = address('new-assistant');
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'ASSISTANT_COACH' }, headCoachId);

    const result = await StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id));

    expect(result.alreadyStaff).toBe(false);
    expect(result.staff.role.type).toBe('ASSISTANT_COACH');
    const account = await prisma.user.findUniqueOrThrow({ where: { id: result.staff.userId } });
    expect(account).toMatchObject({
      email,
      workosUserId: null,
      isManaged: false,
      managedById: null,
      emailVerified: false,
      ageConfirmedAt: null,
      role: 'COACH',
    });
    const stored = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(stored.status).toBe('ACCEPTED');
    expect(stored.acceptedAt).not.toBeNull();
  });

  it('keeps a look-alike account (firstXlast) out of the list and the by-token accept', async () => {
    const lookalikeId = await fx.user('lookalikeXcoach', 'COACH');
    await prisma.user.update({ where: { id: lookalikeId }, data: { workosUserId: `wk-look-${fx.run}` } });
    const email = address('lookalike_coach');

    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'ASSISTANT_COACH' }, headCoachId);

    // An invitation to the look-alike's own address must not be listed for the `_` address.
    const lookalike = await prisma.user.findUniqueOrThrow({ where: { id: lookalikeId }, select: { email: true } });
    const other = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email: lookalike.email!, roleType: 'ASSISTANT_COACH' },
      headCoachId
    );
    const listed = (await StaffInvitationService.listPendingForEmail(email)).map((row) => row.id);
    expect(listed).toEqual([invitation.id]);
    expect(listed).not.toContain(other.id);
    const result = await StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id));
    expect(result.staff.userId).not.toBe(lookalikeId);
    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: lookalikeId } })).toBe(0);
  });

  it('lists a pending invitation to the account holding the address, case-insensitively, and accept by id uses that account', async () => {
    const inviteeId = await fx.user('existing', 'PLAYER');
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: inviteeId }, select: { email: true } });
    const invitation = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email: stored.email!.toUpperCase(), roleType: 'ASSISTANT_COACH' },
      headCoachId
    );

    const pending = await StaffInvitationService.listPendingForEmail(stored.email);
    expect(pending.map((row) => row.id)).toEqual([invitation.id]);

    const result = await StaffInvitationService.acceptInvitation(invitation.id, inviteeId);
    expect(result.staff.userId).toBe(inviteeId);
    // A coaching role makes the bare PLAYER account a COACH (team creation).
    expect((await prisma.user.findUniqueOrThrow({ where: { id: inviteeId } })).role).toBe('COACH');
  });

  it('refuses by-token accept on an unclaimed managed roster record (409), leaving the invitation pending', async () => {
    const managedId = await fx.user('managed', 'PLAYER');
    await prisma.user.update({ where: { id: managedId }, data: { isManaged: true, managedById: headCoachId } });
    const { email } = await prisma.user.findUniqueOrThrow({ where: { id: managedId }, select: { email: true } });
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email: email!, roleType: 'ASSISTANT_COACH' }, headCoachId);

    await expect(StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id))).rejects.toBeInstanceOf(
      SignInRequiredError
    );

    expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: managedId } })).toBe(0);
    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe('PENDING');
  });

  it('two concurrent accepts of one link end with one account, one staff row and one ACCEPTED transition', async () => {
    for (let round = 0; round < 3; round += 1) {
      const email = address(`race-${round}`);
      const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'ASSISTANT_COACH' }, headCoachId);
      const token = await tokenOf(invitation.id);

      const outcomes = await Promise.allSettled([
        StaffInvitationService.acceptInvitationByToken(token),
        StaffInvitationService.acceptInvitationByToken(token),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(BadRequestError);
      const accounts = await prisma.user.findMany({ where: { email }, select: { id: true } });
      expect(accounts).toHaveLength(1);
      expect(await prisma.teamStaff.count({ where: { teamId: org.teamId, userId: accounts[0].id } })).toBe(1);
    }
  });

  it('an invitation dies with its sender\'s right: a removed head coach cannot come back through it, and no account is left behind', async () => {
    const formerHeadId = await fx.user('former-head', 'COACH');
    await fx.staff(formerHeadId, org);
    const email = address('former-head-alias');
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'HEAD_COACH' }, formerHeadId);
    await prisma.teamStaff.deleteMany({ where: { teamId: org.teamId, userId: formerHeadId } });

    await expect(StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id))).rejects.toThrow(
      'the coach who sent it can no longer manage'
    );

    // The account create ran inside the refused transaction and rolled back with it,
    // and the dead invitation is cancelled so it stops showing as pending.
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe('CANCELLED');
  });

  it('Add Player never adopts an accepted-but-unclaimed staff account as a managed record', async () => {
    const email = address('staff-then-player');
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'ASSISTANT_COACH' }, headCoachId);
    const { staff } = await StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id));

    // Another club's coach adds the same address as a player.
    const otherCoachId = await fx.user('other-coach', 'COACH');
    const other = await fx.org('other-club');
    await fx.staff(otherCoachId, other);
    const result = await InvitationService.addRosterPlayer(other.teamId, { name: 'Staff Person', playerEmail: email }, otherCoachId);

    // Case 3 (invitation only), as for a claimed account: the row stays unmanaged,
    // so nobody gains B2.10 rights to rewrite its email and claim the staff role.
    expect(result.rostered).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    expect(row).toMatchObject({ isManaged: false, managedById: null, email });

    // And the invitee's rejection of that player invitation keeps the address.
    await InvitationService.rejectInvitation(result.invitation!.id, staff.userId);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.userId } })).email).toBe(email);
  });

  it('deleting the sender cancels their PENDING staff invitations, and a deleted ADMIN\'s link is refused', async () => {
    const adminId = await fx.user('admin-sender', 'ADMIN');
    const email = address('admin-target');
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'HEAD_COACH' }, adminId);
    const token = await tokenOf(invitation.id);

    await AccountService.deleteAccount(adminId, { actorId: adminId, mode: 'self' });

    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe('CANCELLED');
    await expect(StaffInvitationService.acceptInvitationByToken(token)).rejects.toBeInstanceOf(BadRequestError);
    // Even were the row still PENDING, the tombstoned inviter fails the re-check.
    await prisma.staffInvitation.update({ where: { id: invitation.id }, data: { status: 'PENDING' } });
    await expect(StaffInvitationService.acceptInvitationByToken(token)).rejects.toThrow(
      'the coach who sent it can no longer manage'
    );
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('removing or demoting a head coach cancels the staff invitations they sent on the team', async () => {
    const secondHeadId = await fx.user('second-head', 'COACH');
    await fx.staff(secondHeadId, org);
    const removed = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email: address('by-removed-head'), roleType: 'ASSISTANT_COACH' },
      secondHeadId
    );
    await TeamService.removeStaffMember(org.teamId, secondHeadId, headCoachId);
    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: removed.id } })).status).toBe('CANCELLED');

    const thirdHeadId = await fx.user('third-head', 'COACH');
    await fx.staff(thirdHeadId, org);
    const demoted = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email: address('by-demoted-head'), roleType: 'ASSISTANT_COACH' },
      thirdHeadId
    );
    // The headCoach's own invitation survives the other head coach's demotion.
    const kept = await StaffInvitationService.inviteStaff(
      org.teamId,
      { email: address('by-staying-head'), roleType: 'ASSISTANT_COACH' },
      headCoachId
    );
    await TeamService.changeStaffRole(org.teamId, thirdHeadId, 'ASSISTANT_COACH', headCoachId);
    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: demoted.id } })).status).toBe('CANCELLED');
    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe('PENDING');
  });

  it('a season rollover carries a pending staff invitation onto the new team-season, where it is accepted', async () => {
    const coachId = await fx.user('rollover-head', 'COACH');
    const club = await fx.org('rollover-club');
    await fx.staff(coachId, club);
    await fx.leagueAdmin(coachId, club);
    await prisma.teamRole.create({
      data: { teamId: club.teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageRoster: true },
    });
    const invitation = await StaffInvitationService.inviteStaff(
      club.teamId,
      { email: address('rollover-invitee'), roleType: 'ASSISTANT_COACH' },
      coachId
    );

    const { team } = await TeamService.rolloverTeam(club.teamId, { seasonName: `S2-${fx.run}` }, coachId);

    const moved = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(moved).toMatchObject({ teamId: team.id, status: 'PENDING' });
    const result = await StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id));
    expect(result.staff.teamId).toBe(team.id);
  });

  it('a managing coach cannot rewrite the email of a managed record that holds a staff role', async () => {
    // A managed record on the club's roster, managed by the head coach, that
    // got a staff role some way (here directly): its email is now fixed.
    const managedId = await fx.user('managed-staff', 'PLAYER');
    await prisma.user.update({ where: { id: managedId }, data: { isManaged: true, managedById: headCoachId } });
    await fx.member(managedId, org);
    const assistantRole = await prisma.teamRole.findFirstOrThrow({ where: { teamId: org.teamId, type: 'ASSISTANT_COACH' } });
    await prisma.teamStaff.create({ data: { teamId: org.teamId, userId: managedId, roleId: assistantRole.id } });

    await expect(
      PlayerService.updatePlayer(managedId, { email: address('coach-alias') }, headCoachId)
    ).rejects.toThrow('holds a staff role');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: managedId } })).email).not.toBe(address('coach-alias'));

    // Without the staff row the managing coach may correct it (B2.10, unchanged).
    await prisma.teamStaff.deleteMany({ where: { userId: managedId } });
    await PlayerService.updatePlayer(managedId, { email: address('fixed-address') }, headCoachId);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: managedId } })).email).toBe(address('fixed-address'));
  });

  it('the resend cooldown survives a season rollover (keyed on the lineage)', async () => {
    const coachId = await fx.user('cooldown-head', 'COACH');
    const club = await fx.org('cooldown-club');
    await fx.staff(coachId, club);
    await fx.leagueAdmin(coachId, club);
    await prisma.teamRole.create({
      data: { teamId: club.teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageRoster: true },
    });
    const email = address('cooldown-invitee');
    const first = await StaffInvitationService.inviteStaff(club.teamId, { email, roleType: 'ASSISTANT_COACH' }, coachId);
    await StaffInvitationService.cancelInvitation(club.teamId, first.id, coachId);

    const { team } = await TeamService.rolloverTeam(club.teamId, { seasonName: `S3-${fx.run}` }, coachId);

    await expect(
      StaffInvitationService.inviteStaff(team.id, { email, roleType: 'ASSISTANT_COACH' }, coachId)
    ).rejects.toMatchObject({ code: 'resend_cooldown' });
  });

  it('a team manager invitation creates a PLAYER account (the app asks the role step)', async () => {
    const email = address('manager');
    await prisma.teamRole.create({
      data: { teamId: org.teamId, type: 'TEAM_MANAGER', name: 'Team Manager', canTrackStats: true, canViewStats: true },
    });
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email, roleType: 'TEAM_MANAGER' }, headCoachId);

    const result = await StaffInvitationService.acceptInvitationByToken(await tokenOf(invitation.id));

    expect(result.staff.role.type).toBe('TEAM_MANAGER');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: result.staff.userId } })).role).toBe('PLAYER');
  });

  it('decline strips the address from the row; the hash keeps the cooldown', async () => {
    const inviteeId = await fx.user('decliner', 'COACH');
    const { email } = await prisma.user.findUniqueOrThrow({ where: { id: inviteeId }, select: { email: true } });
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email: email!, roleType: 'ASSISTANT_COACH' }, headCoachId);

    const rejected = await StaffInvitationService.rejectInvitation(invitation.id, inviteeId);

    expect(rejected.status).toBe('REJECTED');
    expect(await prisma.staffInvitation.count({ where: { invitedEmail: { equals: email!, mode: 'insensitive' } } })).toBe(0);
    // A Resend at once is refused by the cooldown: the hash outlives the address.
    await expect(
      StaffInvitationService.inviteStaff(
        org.teamId,
        { email: email!, roleType: 'ASSISTANT_COACH', supersede: true },
        headCoachId
      )
    ).rejects.toMatchObject({ code: 'resend_cooldown' });
  });

  it('account deletion expires a PENDING staff invitation to the address and scrubs every one', async () => {
    const inviteeId = await fx.user('leaver', 'COACH');
    const { email } = await prisma.user.findUniqueOrThrow({ where: { id: inviteeId }, select: { email: true } });
    const invitation = await StaffInvitationService.inviteStaff(org.teamId, { email: email!, roleType: 'ASSISTANT_COACH' }, headCoachId);

    await AccountService.deleteAccount(inviteeId, { actorId: inviteeId, mode: 'self' });

    const row = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.status).toBe('EXPIRED');
    expect(row.invitedEmail).toBe(`deleted-${invitation.id}@invalid`);
    expect(row.recipientHash).toBe('');
  });
});
