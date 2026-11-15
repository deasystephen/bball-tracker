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

    expect(await StaffInvitationService.listPendingForUser(lookalikeId)).toEqual([]);
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

    const pending = await StaffInvitationService.listPendingForUser(inviteeId);
    expect(pending.map((row) => row.id)).toEqual([invitation.id]);

    const result = await StaffInvitationService.acceptInvitation(invitation.id, inviteeId);
    expect(result.staff.userId).toBe(inviteeId);
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

    // The account create ran inside the refused transaction and rolled back with it.
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect((await prisma.staffInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe('PENDING');
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
    // Re-inviting at once is refused by the cooldown, not lost with the address.
    await expect(
      StaffInvitationService.inviteStaff(org.teamId, { email: email!, roleType: 'ASSISTANT_COACH' }, headCoachId)
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
