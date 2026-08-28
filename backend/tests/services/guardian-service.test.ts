/**
 * Unit tests for GuardianService (PARENT role — docs/plans/parent-role-spec.md)
 */

import { GuardianService } from '../../src/services/guardian-service';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach, createPlayer, createTeam, createUser } from '../factories';
import {
  expectBadRequestError,
  expectForbiddenError,
  expectNotFoundError,
} from '../helpers';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

const mockedMailerSend = (
  jest.requireMock('../../src/services/mailer') as unknown as { mailer: { send: jest.Mock } }
).mailer.send;

const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const CHILD_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';

function child(
  overrides: Partial<{ name: string; email: string | null }> = {}
): { id: string; name: string; email: string | null } {
  return { id: CHILD_ID, name: 'Kid Smith', email: null, ...overrides };
}

/** hasTeamPermission for a plain (non-admin, non-league-admin) caller. */
function setStaffPermission(canManageRoster: boolean): void {
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
    ...createTeam({ id: TEAM_ID }),
    season: { league: { admins: [] } },
  });
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue(
    canManageRoster ? [{ role: { canManageRoster: true, canViewStats: true } }] : []
  );
  (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue(null);
}

/**
 * A GuardianInvitation row as the service reads it back through
 * GUARDIAN_INVITATION_SELECT (no `token` — it must never be returned).
 */
function invitationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> & {
  id: string;
  expiresAt: Date;
  status: string;
} {
  return {
    id: 'inv-1',
    childId: CHILD_ID,
    teamId: TEAM_ID,
    invitedEmail: 'parent@test.com',
    relationship: 'MOTHER',
    invitedById: 'coach-1',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    acceptedAt: null,
    ...overrides,
  };
}

describe('GuardianService', () => {
  describe('getGuardianOf', () => {
    it('maps guardian links to { childId, childName, relationship, isPrimary }', async () => {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([
        {
          childId: 'c1',
          relationship: 'FATHER',
          isPrimary: true,
          child: { name: 'Kid One', teamMembers: [{ team: { id: 't1', name: 'Warriors' } }] },
        },
        { childId: 'c2', relationship: 'OTHER', isPrimary: false, child: { name: 'Kid Two', teamMembers: [] } },
      ]);

      const result = await GuardianService.getGuardianOf('parent-1');

      expect(result).toEqual([
        { childId: 'c1', childName: 'Kid One', relationship: 'FATHER', isPrimary: true, teams: [{ id: 't1', name: 'Warriors' }] },
        { childId: 'c2', childName: 'Kid Two', relationship: 'OTHER', isPrimary: false, teams: [] },
      ]);
      expect(mockPrisma.guardian.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentId: 'parent-1' } })
      );
    });
  });

  describe('getChildIds', () => {
    it('returns the child ids', async () => {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([{ childId: 'c1' }, { childId: 'c2' }]);
      expect(await GuardianService.getChildIds('p')).toEqual(['c1', 'c2']);
    });
  });

  describe('listPendingForUser', () => {
    it('returns the public view of pending, unexpired invitations addressed to the caller email', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ email: 'Mom@Example.com' });
      const expiresAt = new Date(Date.now() + 86400000);
      (mockPrisma.guardianInvitation.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: 'gi-1',
          status: 'PENDING',
          relationship: 'MOTHER',
          expiresAt,
          child: { name: 'Kid Smith' },
          team: { name: 'Lakers' },
          invitedBy: { name: 'Coach' },
          token: 'must-not-leak',
        },
      ]);

      const result = await GuardianService.listPendingForUser('parent-1');

      expect(result).toEqual([
        {
          kind: 'guardian',
          id: 'gi-1',
          status: 'PENDING',
          childName: 'Kid Smith',
          teamName: 'Lakers',
          inviterName: 'Coach',
          relationship: 'MOTHER',
          expiresAt: expiresAt.toISOString(),
        },
      ]);
      expect(mockPrisma.guardianInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            invitedEmail: { equals: 'Mom@Example.com', mode: 'insensitive' },
            status: 'PENDING',
            expiresAt: { gt: expect.any(Date) },
          }),
        })
      );
    });

    it('returns [] for an account without an email', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce({ email: null });
      expect(await GuardianService.listPendingForUser('kid')).toEqual([]);
      expect(mockPrisma.guardianInvitation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('inviteGuardian', () => {
    const coach = createCoach({ id: 'coach-1' });
    const input = { email: 'Parent@Test.com', relationship: 'MOTHER' as const };

    function setHappyPath(options: { existingParent?: ReturnType<typeof createUser> | null } = {}): void {
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(async (args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === coach.id) return coach;
        return null;
      });
      // Parent lookup is case-insensitive (findFirst) since red-team RT1/RT8
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(options.existingParent ?? null);
      setStaffPermission(true);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: 'parent-1', name: 'parent', email: 'parent@test.com' });
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.guardianInvitation.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.guardianInvitation.create as jest.Mock).mockResolvedValue(invitationRow());
    }

    it('throws NotFoundError when the team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
    });

    it('throws ForbiddenError when the caller cannot manage the roster', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createPlayer());
      setStaffPermission(false);

      try {
        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, 'player-1');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err);
      }
      expect(mockPrisma.guardianInvitation.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the player is not on the team', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setStaffPermission(true);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Player is not on this team');
      }
    });

    it('rejects inviting the player as their own guardian', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setStaffPermission(true);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child({ email: 'parent@test.com' }) });

      try {
        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'A player cannot be their own guardian');
      }
    });

    it('creates a PARENT user for a new email, the invitation, and emails the accept link', async () => {
      setHappyPath();
      process.env.PUBLIC_APP_URL = 'https://capyhoops.com';

      const result = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'parent@test.com', role: 'PARENT', emailVerified: false }),
        })
      );
      expect(mockPrisma.user.create.mock.calls[0][0].data).not.toHaveProperty('isManaged');
      expect(mockPrisma.guardianInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            childId: CHILD_ID,
            teamId: TEAM_ID,
            invitedEmail: 'parent@test.com',
            relationship: 'MOTHER',
            invitedById: coach.id,
            status: 'PENDING',
            token: expect.any(String),
          }),
        })
      );
      expect(result).not.toHaveProperty('token');

      expect(mockedMailerSend).toHaveBeenCalledTimes(1);
      const sendArgs = mockedMailerSend.mock.calls[0][0];
      expect(sendArgs.to).toBe('parent@test.com');
      expect(sendArgs.template.name).toBe('guardian-invitation');
      expect(sendArgs.variables.childName).toBe('Kid Smith');
      expect(sendArgs.variables.acceptUrl).toMatch(/^https:\/\/capyhoops\.com\/invite\/[A-Za-z0-9_-]+$/);
      expect(sendArgs.metadata.event_type).toBe('guardian_invitation.created');
    });

    it('reuses an existing account for the email without changing its role', async () => {
      const existing = createCoach({ id: 'other-coach', email: 'parent@test.com' });
      setHappyPath({ existingParent: existing });

      await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);

      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.guardian.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentId_childId: { parentId: existing.id, childId: CHILD_ID } } })
      );
    });

    it('rejects when the person is already a guardian of the player', async () => {
      setHappyPath();
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-1' });

      try {
        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'This person is already a guardian of this player');
      }
      expect(mockPrisma.guardianInvitation.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate live PENDING invitation', async () => {
      setHappyPath();
      (mockPrisma.guardianInvitation.findFirst as jest.Mock).mockResolvedValue(invitationRow());

      try {
        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'A pending guardian invitation already exists for this email');
      }
    });

    it('expires a stale PENDING invitation and creates a new one', async () => {
      setHappyPath();
      (mockPrisma.guardianInvitation.findFirst as jest.Mock).mockResolvedValue(
        invitationRow({ id: 'stale', expiresAt: new Date(Date.now() - 1000) })
      );
      (mockPrisma.guardianInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);

      expect(mockPrisma.guardianInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'stale', status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      expect(mockPrisma.guardianInvitation.create).toHaveBeenCalledTimes(1);
    });

    it('reports emailSent: false when the email fails to send — invitation still committed', async () => {
      setHappyPath();
      mockedMailerSend.mockRejectedValueOnce(new Error('SES down'));

      const result = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);

      // The SES-incident fix: a failed send is reported, never thrown and
      // never silent (unification spec).
      expect(result.emailSent).toBe(false);
      expect(result).toHaveProperty('id');
    });

    it('reports emailSent: true on a successful send', async () => {
      setHappyPath();

      const result = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id);

      expect(result.emailSent).toBe(true);
    });
  });

  describe('listGuardians', () => {
    const guardianRows = [
      {
        id: 'g-1',
        parentId: 'parent-1',
        childId: CHILD_ID,
        relationship: 'MOTHER',
        isPrimary: true,
        createdAt: new Date(),
        parent: { id: 'parent-1', name: 'Mom', email: 'mom@test.com' },
      },
    ];

    it('throws NotFoundError when the player is not on the team', async () => {
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.listGuardians(TEAM_ID, CHILD_ID, 'coach-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Player is not on this team');
      }
    });

    it('returns guardians with emails and pending invitations for a roster manager', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      setStaffPermission(true);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue(guardianRows);
      (mockPrisma.guardianInvitation.findMany as jest.Mock).mockResolvedValue([invitationRow()]);

      const result = await GuardianService.listGuardians(TEAM_ID, CHILD_ID, 'coach-1');

      expect(result.guardians).toEqual([
        expect.objectContaining({ userId: 'parent-1', name: 'Mom', email: 'mom@test.com', isPrimary: true }),
      ]);
      expect(result.pendingInvitations).toHaveLength(1);
      expect(mockPrisma.guardianInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ childId: CHILD_ID, status: 'PENDING' }),
        })
      );
    });

    it('strips guardian emails for a guardian (non-manager) caller', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createUser({ role: 'PARENT' }));
      setStaffPermission(false);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-1' });
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue(guardianRows);
      (mockPrisma.guardianInvitation.findMany as jest.Mock).mockResolvedValue([]);

      const result = await GuardianService.listGuardians(TEAM_ID, CHILD_ID, 'parent-1');

      expect(result.guardians[0]).not.toHaveProperty('email');
      expect(result.guardians[0].name).toBe('Mom');
    });

    it('throws ForbiddenError for a caller who is neither manager nor guardian', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createPlayer());
      setStaffPermission(false);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.listGuardians(TEAM_ID, CHILD_ID, 'stranger');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err);
      }
    });
  });

  describe('removeGuardian', () => {
    beforeEach(() => {
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
    });

    it('throws NotFoundError when the player is not on the team', async () => {
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.removeGuardian(TEAM_ID, CHILD_ID, 'parent-1', 'coach-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Player is not on this team');
      }
    });

    it('throws ForbiddenError when a non-manager removes someone else', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createPlayer());
      setStaffPermission(false);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });

      try {
        await GuardianService.removeGuardian(TEAM_ID, CHILD_ID, 'parent-1', 'other-parent');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err);
      }
      expect(mockPrisma.guardian.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when no link exists', async () => {
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.removeGuardian(TEAM_ID, CHILD_ID, 'parent-1', 'parent-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Guardian link not found');
      }
    });

    it('lets a guardian remove themself and promotes the next guardian to primary', async () => {
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-1', isPrimary: true });
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue({ id: 'g-2' });

      await GuardianService.removeGuardian(TEAM_ID, CHILD_ID, 'parent-1', 'parent-1');

      expect(mockPrisma.guardian.delete).toHaveBeenCalledWith({ where: { id: 'g-1' } });
      expect(mockPrisma.guardian.update).toHaveBeenCalledWith({ where: { id: 'g-2' }, data: { isPrimary: true } });
      // No permission lookup needed for self-removal
      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
    });

    it('lets a roster manager remove the last guardian without touching the child', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
      setStaffPermission(true);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-1', isPrimary: true });
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue(null);

      await GuardianService.removeGuardian(TEAM_ID, CHILD_ID, 'parent-1', 'coach-1');

      expect(mockPrisma.guardian.delete).toHaveBeenCalledWith({ where: { id: 'g-1' } });
      expect(mockPrisma.guardian.update).not.toHaveBeenCalled();
      expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    });

    it('does not promote anyone when a non-primary guardian leaves', async () => {
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-2', isPrimary: false });

      await GuardianService.removeGuardian(TEAM_ID, CHILD_ID, 'parent-2', 'parent-2');

      expect(mockPrisma.guardian.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.guardian.update).not.toHaveBeenCalled();
    });
  });

  describe('getInvitationByToken', () => {
    it('throws NotFoundError for an unknown token', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.getInvitationByToken('nope');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Invitation not found');
      }
    });

    it('returns the limited public view with kind: guardian', async () => {
      const expiresAt = new Date(Date.now() + 1000);
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue({
        id: 'inv-1',
        status: 'PENDING',
        relationship: 'FATHER',
        expiresAt,
        child: { name: 'Kid Smith' },
        team: { name: 'Lakers' },
        invitedBy: { name: 'Coach' },
      });

      const result = await GuardianService.getInvitationByToken('tok');

      expect(result).toEqual({
        kind: 'guardian',
        id: 'inv-1',
        status: 'PENDING',
        childName: 'Kid Smith',
        teamName: 'Lakers',
        inviterName: 'Coach',
        relationship: 'FATHER',
        expiresAt: expiresAt.toISOString(),
      });
      expect(result).not.toHaveProperty('invitedEmail');
    });

    it('returns teamName null when the team was deleted', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue({
        id: 'inv-1',
        status: 'PENDING',
        relationship: 'FATHER',
        expiresAt: new Date(),
        child: { name: 'Kid Smith' },
        team: null,
        invitedBy: { name: 'Coach' },
      });

      const result = await GuardianService.getInvitationByToken('tok');
      expect(result.teamName).toBeNull();
    });
  });

  describe('acceptInvitationByToken', () => {
    type Tx = {
      guardianInvitation: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
      guardian: { findUnique: jest.Mock; count: jest.Mock; create: jest.Mock };
      teamMember: { count: jest.Mock };
      teamStaff: { count: jest.Mock };
      user: { update: jest.Mock };
    };

    function setTx(overrides: Partial<{
      updateCount: number;
      existingLink: unknown;
      guardianCount: number;
      memberships: number;
      staffRows: number;
    }> = {}): Tx {
      const tx: Tx = {
        guardianInvitation: {
          updateMany: jest.fn().mockResolvedValue({ count: overrides.updateCount ?? 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(invitationRow({ status: 'ACCEPTED', acceptedAt: new Date() })),
        },
        guardian: {
          findUnique: jest.fn().mockResolvedValue(overrides.existingLink ?? null),
          count: jest.fn().mockResolvedValue(overrides.guardianCount ?? 0),
          create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'g-new', ...data })),
        },
        teamMember: { count: jest.fn().mockResolvedValue(overrides.memberships ?? 0) },
        teamStaff: { count: jest.fn().mockResolvedValue(overrides.staffRows ?? 0) },
        user: { update: jest.fn().mockResolvedValue({}) },
      };
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: (t: Tx) => unknown) => cb(tx));
      return tx;
    }

    it('throws NotFoundError for an unknown token', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.acceptInvitationByToken('nope');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Invitation not found');
      }
    });

    it('rejects an already-accepted invitation', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow({ status: 'ACCEPTED' }));

      try {
        await GuardianService.acceptInvitationByToken('tok');
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'This invitation has already been accepted');
      }
    });

    it('rejects a cancelled invitation', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow({ status: 'CANCELLED' }));

      try {
        await GuardianService.acceptInvitationByToken('tok');
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'Cannot accept invitation with status: CANCELLED');
      }
    });

    it('marks an expired invitation EXPIRED and rejects', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(
        invitationRow({ expiresAt: new Date(Date.now() - 1000) })
      );
      (mockPrisma.guardianInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      try {
        await GuardianService.acceptInvitationByToken('tok');
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'This invitation has expired');
      }
      expect(mockPrisma.guardianInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    });

    it('creates the Guardian link (primary when first) and promotes a bare PLAYER account to PARENT', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PLAYER' });
      const tx = setTx();

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(result.kind).toBe('guardian');
      expect(result.invitation.status).toBe('ACCEPTED');
      expect(result.invitation).not.toHaveProperty('token');
      expect(result.guardian).toEqual({
        id: 'g-new',
        parentId: 'parent-1',
        childId: CHILD_ID,
        relationship: 'MOTHER',
        isPrimary: true,
      });
      expect(tx.guardianInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv-1', status: 'PENDING' } })
      );
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'parent-1' }, data: { role: 'PARENT' } });
    });

    it('is not primary when the child already has a guardian', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-2', role: 'PARENT' });
      setTx({ guardianCount: 1 });

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(result.guardian.isPrimary).toBe(false);
    });

    it('keeps a COACH account as COACH', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'coach-2', role: 'COACH' });
      const tx = setTx();

      await GuardianService.acceptInvitationByToken('tok');

      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.teamMember.count).not.toHaveBeenCalled();
    });

    it('keeps a PLAYER who is rostered somewhere as PLAYER', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'player-2', role: 'PLAYER' });
      const tx = setTx({ memberships: 1 });

      await GuardianService.acceptInvitationByToken('tok');

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('keeps a PLAYER who is team staff as PLAYER', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'player-2', role: 'PLAYER' });
      const tx = setTx({ staffRows: 1 });

      await GuardianService.acceptInvitationByToken('tok');

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('reuses an existing Guardian link instead of creating a duplicate', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PARENT' });
      const existing = { id: 'g-old', parentId: 'parent-1', childId: CHILD_ID, relationship: 'OTHER', isPrimary: true };
      const tx = setTx({ existingLink: existing });

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(tx.guardian.create).not.toHaveBeenCalled();
      expect(result.guardian.id).toBe('g-old');
    });

    it('creates the PARENT account when none exists for the invited email', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: 'parent-new', role: 'PARENT' });
      setTx();

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'parent@test.com', role: 'PARENT' }) })
      );
      expect(result.guardian.parentId).toBe('parent-new');
    });

    it('returns 400 (not 500) when a concurrent accept already moved it out of PENDING', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PARENT' });
      const tx = setTx({ updateCount: 0 });

      try {
        await GuardianService.acceptInvitationByToken('tok');
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'Cannot accept invitation: it is no longer pending');
      }
      expect(tx.guardian.create).not.toHaveBeenCalled();
    });
  });

  describe('authenticated accept / reject / findInvitationForUser', () => {
    it('findInvitationForUser returns null for an unknown id', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await GuardianService.findInvitationForUser('nope', 'u')).toBeNull();
    });

    it('findInvitationForUser throws ForbiddenError when the caller is not the addressee', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'someone-else@test.com' });

      try {
        await GuardianService.findInvitationForUser('inv-1', 'u');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'This invitation was not sent to you');
      }
    });

    it('findInvitationForUser throws ForbiddenError when the caller has no email', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: null });

      await expect(GuardianService.findInvitationForUser('inv-1', 'u')).rejects.toMatchObject({ statusCode: 403 });
    });

    it('acceptInvitation throws NotFoundError for an unknown id', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.acceptInvitation('nope', 'u');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Invitation not found');
      }
    });

    it('acceptInvitation accepts for the addressee (case-insensitive email match)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-1', email: 'PARENT@test.com', role: 'PARENT' });
      const tx = {
        guardianInvitation: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(invitationRow({ status: 'ACCEPTED' })),
        },
        guardian: {
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue({ id: 'g', parentId: 'parent-1', childId: CHILD_ID, relationship: 'MOTHER', isPrimary: true }),
        },
        user: { update: jest.fn() },
      };
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

      const result = await GuardianService.acceptInvitation('inv-1', 'parent-1');

      expect(result.guardian.id).toBe('g');
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('rejectInvitation marks the invitation REJECTED for the addressee', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'parent@test.com' });
      (mockPrisma.guardianInvitation.update as jest.Mock).mockResolvedValue(invitationRow({ status: 'REJECTED' }));

      const result = await GuardianService.rejectInvitation('inv-1', 'parent-1');

      expect(result.status).toBe('REJECTED');
      expect(mockPrisma.guardianInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv-1' }, data: { status: 'REJECTED' } })
      );
    });

    it('rejectInvitation refuses a non-PENDING invitation', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow({ status: 'ACCEPTED' }));
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'parent@test.com' });

      try {
        await GuardianService.rejectInvitation('inv-1', 'parent-1');
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'Cannot reject invitation with status: ACCEPTED');
      }
    });

    it('rejectInvitation throws NotFoundError for an unknown id', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(GuardianService.rejectInvitation('nope', 'u')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('admin short-circuit', () => {
    it('a system admin may invite without a staff row', async () => {
      const admin = createAdmin({ id: 'admin-1' });
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(async (args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === admin.id) return admin;
        return null;
      });
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(createTeam({ id: TEAM_ID }));
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ player: child() });
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: 'parent-1', name: 'p', email: 'parent@test.com' });
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.guardianInvitation.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.guardianInvitation.create as jest.Mock).mockResolvedValue(invitationRow());

      await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, { email: 'parent@test.com', relationship: 'OTHER' }, admin.id);

      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.guardianInvitation.create).toHaveBeenCalledTimes(1);
    });
  });
});
