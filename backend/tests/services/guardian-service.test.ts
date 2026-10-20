/**
 * Unit tests for GuardianService (PARENT role — docs/plans/parent-role-spec.md)
 */

import { USER_SUMMARY_WITH_EMAIL_SELECT } from '../../src/utils/user-select';
import { Prisma } from '@prisma/client';
import { GuardianService } from '../../src/services/guardian-service';
import { INVITATION_RESEND_COOLDOWN_MS } from '../../src/utils/resend-cooldown';
import { ResendCooldownError } from '../../src/utils/errors';
import { emailEquals } from '../../src/utils/email-match';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach, createPlayer, createTeam, createUser, uniqueViolation } from '../factories';
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

/** The ids a `lockUsers` call (`… IN (${Prisma.join(ids)}) …`) asked for, in call order. */
function lockedIds(call: unknown[]): string[] {
  // A `Prisma.join` fragment carries its parameters in `values`.
  return call.slice(1).flatMap((value) =>
    typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown }).values)
      ? ((value as { values: string[] }).values)
      : [value as string]
  );
}

/** `$queryRaw` stand-in for `lockUsers`: every requested row exists, live unless listed in `tombstoned`. */
function echoLockedRows(tombstoned: string[] = []): jest.Mock {
  return jest.fn().mockImplementation(async (...call: unknown[]) =>
    lockedIds(call).map((id) => ({ id, deletedAt: tombstoned.includes(id) ? new Date() : null }))
  );
}

const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const CHILD_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';
/** The caller team's lineage: the club across seasons (#420 Resend scope). */
const LINEAGE_ID = 'lineage-warriors';

function child(
  overrides: Partial<{ name: string; email: string | null }> = {}
): { id: string; name: string; email: string | null } {
  return { id: CHILD_ID, name: 'Kid Smith', email: null, ...overrides };
}

/** hasTeamPermission for a plain (non-admin, non-league-admin) caller. */
function setStaffPermission(canManageRoster: boolean): void {
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
    ...createTeam({ id: TEAM_ID, lineageId: LINEAGE_ID }),
    season: { league: { admins: [] } },
  });
  (mockPrisma.teamStaff.findUnique as jest.Mock).mockResolvedValue(
    canManageRoster ? { role: { canManageRoster: true, canViewStats: true } } : null
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
    it('maps guardian links to { childId, childName, relationship, isPrimary, isManaged, teams }', async () => {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([
        {
          childId: 'c1',
          relationship: 'FATHER',
          isPrimary: true,
          child: { name: 'Kid One', deletedAt: null, isManaged: true, workosUserId: null, teamMembers: [{ team: { id: 't1', name: 'Warriors' } }] },
        },
        {
          childId: 'c2',
          relationship: 'OTHER',
          isPrimary: false,
          // Claimed account: managed flag already cleared by syncUser, and it has a login
          child: { name: 'Kid Two', deletedAt: new Date('2026-09-02T00:00:00.000Z'), isManaged: false, workosUserId: 'workos_kid', teamMembers: [] },
        },
        {
          childId: 'c3',
          relationship: 'MOTHER',
          isPrimary: false,
          // Managed flag still set but the child has a login: not deletable by a guardian
          child: { name: 'Kid Three', deletedAt: null, isManaged: true, workosUserId: 'workos_kid3', teamMembers: [] },
        },
      ]);

      const result = await GuardianService.getGuardianOf('parent-1');

      // isManaged marks the only kind of child record a guardian may delete (#444 D5)
      expect(result).toEqual([
        { childId: 'c1', childName: 'Kid One', childDeletedAt: null, relationship: 'FATHER', isPrimary: true, isManaged: true, teams: [{ id: 't1', name: 'Warriors' }] },
        { childId: 'c2', childName: 'Kid Two', childDeletedAt: '2026-09-02T00:00:00.000Z', relationship: 'OTHER', isPrimary: false, isManaged: false, teams: [] },
        { childId: 'c3', childName: 'Kid Three', childDeletedAt: null, relationship: 'MOTHER', isPrimary: false, isManaged: false, teams: [] },
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
          child: { name: 'Kid Smith', deletedAt: new Date('2026-09-02T00:00:00.000Z') },
          team: { name: 'Lakers' },
          invitedBy: { name: 'Coach', deletedAt: new Date('2026-09-01T00:00:00.000Z') },
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
          childDeletedAt: '2026-09-02T00:00:00.000Z',
          teamName: 'Lakers',
          inviterName: 'Coach',
          // Deleted inviter: the client labels from this, never the name (#813).
          inviterDeletedAt: '2026-09-01T00:00:00.000Z',
          relationship: 'MOTHER',
          expiresAt: expiresAt.toISOString(),
        },
      ]);
      expect(mockPrisma.guardianInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            child: { select: { name: true, deletedAt: true } },
            invitedBy: { select: { name: true, deletedAt: true } },
          }),
        })
      );
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
      process.env.PUBLIC_APP_URL = 'https://app.example.test';

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
      expect(sendArgs.variables.acceptUrl).toMatch(/^https:\/\/app\.example\.test\/invite\/[A-Za-z0-9_-]+$/);
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

    it('answers the dedupe 400 when a concurrent invite wins the partial PENDING index (P2002, #727)', async () => {
      setHappyPath();
      (mockPrisma.guardianInvitation.create as jest.Mock).mockRejectedValue(
        uniqueViolation('GuardianInvitation_pending_childId_invitedEmail_key')
      );

      const error = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id).catch((e) => e);

      expectBadRequestError(error, 'A pending guardian invitation already exists for this email');
      expect(mockedMailerSend).not.toHaveBeenCalled();
    });

    it('propagates a P2002 on another unique (token collision), which the dedupe message does not describe', async () => {
      setHappyPath();
      const tokenClash = uniqueViolation('GuardianInvitation_token_key');
      (mockPrisma.guardianInvitation.create as jest.Mock).mockRejectedValue(tokenClash);

      await expect(GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id)).rejects.toBe(tokenClash);
    });

    it('propagates an invitation create failure that is not P2002', async () => {
      setHappyPath();
      const boom = new Error('connection reset');
      (mockPrisma.guardianInvitation.create as jest.Mock).mockRejectedValue(boom);

      await expect(GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, input, coach.id)).rejects.toBe(boom);
    });

    describe('supersede (Resend, #420)', () => {
      const resend = { ...input, supersede: true };
      const OLDER_THAN_COOLDOWN = new Date(Date.now() - INVITATION_RESEND_COOLDOWN_MS - 60_000);

      /**
       * `guardianInvitation.findFirst` answering per query: the cooldown read
       * (within the lineage) sees `latest`; the cross-lineage dedupe read
       * (`NOT: { team: { lineageId } }`) sees `elsewhere`.
       */
      function mockInvitationReads(latest: unknown, elsewhere: unknown = null): void {
        (mockPrisma.guardianInvitation.findFirst as jest.Mock).mockImplementation(
          async (args: { where: { NOT?: unknown } }) => (args.where.NOT ? elsewhere : latest)
        );
      }

      /** Happy path plus a live PENDING row for the pair, created before the cooldown window. */
      function setLivePending(): void {
        setHappyPath();
        mockInvitationReads(invitationRow({ id: 'live', createdAt: OLDER_THAN_COOLDOWN }));
        (mockPrisma.guardianInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        (mockPrisma.guardianInvitation.create as jest.Mock).mockResolvedValue(invitationRow({ id: 'fresh' }));
      }

      it('expires the live PENDING row and creates the replacement in one transaction, then mails the new link', async () => {
        setLivePending();

        const result = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id);

        // A live row would 400 without supersede; here it is expired instead.
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        // First the lazy expiry of a lapsed row on ANY team (as the plain invite
        // does), then the live row within the caller team's lineage. Both match the
        // address through emailEquals.
        expect(mockPrisma.guardianInvitation.updateMany).toHaveBeenNthCalledWith(1, {
          where: {
            childId: CHILD_ID,
            invitedEmail: emailEquals('parent@test.com'),
            status: 'PENDING',
            expiresAt: { lte: expect.any(Date) },
          },
          data: { status: 'EXPIRED' },
        });
        expect(mockPrisma.guardianInvitation.updateMany).toHaveBeenNthCalledWith(2, {
          where: {
            childId: CHILD_ID,
            invitedEmail: emailEquals('parent@test.com'),
            status: 'PENDING',
            team: { lineageId: LINEAGE_ID },
          },
          data: { status: 'EXPIRED' },
        });
        expect(mockPrisma.guardianInvitation.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ childId: CHILD_ID, invitedEmail: 'parent@test.com', status: 'PENDING', token: expect.any(String) }),
          })
        );
        // Expire before create: the partial index allows one PENDING row.
        expect(mockPrisma.guardianInvitation.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          mockPrisma.guardianInvitation.create.mock.invocationCallOrder[0]
        );
        expect(result).toMatchObject({ id: 'fresh', emailSent: true });
        expect(result).not.toHaveProperty('token');
        expect(mockedMailerSend).toHaveBeenCalledTimes(1);
        expect(mockedMailerSend.mock.calls[0][0].to).toBe('parent@test.com');
      });

      it('reports emailSent: false when the resend email fails, with the replacement committed', async () => {
        setLivePending();
        mockedMailerSend.mockRejectedValueOnce(new Error('SES down'));

        const result = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id);

        expect(result).toMatchObject({ id: 'fresh', emailSent: false });
      });

      it('for an existing account, skips the pre-check and refuses a cooldown inside the locked transaction', async () => {
        setLivePending();
        (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', name: 'Mom', email: 'parent@test.com' });
        mockInvitationReads(invitationRow({ id: 'live', createdAt: new Date(Date.now() - 10_000) }));

        await expect(GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id)).rejects.toBeInstanceOf(
          ResendCooldownError
        );

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockPrisma.guardianInvitation.findFirst).toHaveBeenCalledTimes(1);
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockPrisma.guardianInvitation.create).not.toHaveBeenCalled();
      });

      it("refuses another club's live invitation with the dedupe 400 before creating an account", async () => {
        setLivePending();
        mockInvitationReads(null, invitationRow({ id: 'other-club', teamId: 'other-team' }));

        const err = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id).catch((e) => e);

        expectBadRequestError(err, 'A pending guardian invitation already exists for this email');
        expect(mockPrisma.guardianInvitation.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: 'PENDING',
              expiresAt: { gt: expect.any(Date) },
              NOT: { team: { lineageId: LINEAGE_ID } },
            }),
          })
        );
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('looks the address up once when it has no account (the pre-read is passed on)', async () => {
        setLivePending();

        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id);

        expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(1);
        expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
      });

      it('creates a fresh invitation when there is no prior row for the pair', async () => {
        setHappyPath();
        (mockPrisma.guardianInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const result = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id);

        expect(mockPrisma.guardianInvitation.create).toHaveBeenCalledTimes(1);
        expect(result.emailSent).toBe(true);
      });

      it('refuses with 429 resend_cooldown inside the window, expiring nothing and mailing no one', async () => {
        setLivePending();
        mockInvitationReads(invitationRow({ id: 'live', createdAt: new Date(Date.now() - 30_000) }));

        const err = (await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id).catch(
          (e: unknown) => e
        )) as ResendCooldownError;

        expect(err).toBeInstanceOf(ResendCooldownError);
        expect(err.statusCode).toBe(429);
        expect(err.body()).toMatchObject({ code: 'resend_cooldown', retryAfterSeconds: expect.any(Number) });
        expect(err.message).toMatch(/just sent to this address/);
        // The newest row of ANY status counts, so a decline between resends does not reset the clock.
        expect(mockPrisma.guardianInvitation.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            // This club's rows only: another club's invite is not "just sent" by the caller.
            where: { childId: CHILD_ID, invitedEmail: emailEquals('parent@test.com'), team: { lineageId: LINEAGE_ID } },
            orderBy: { createdAt: 'desc' },
          })
        );
        // No account existed for the address: the refusal creates none (the
        // cooldown pre-check runs before the create) and never reads the inviter.
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalledWith({
          where: { id: coach.id },
          select: { name: true, email: true },
        });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.guardianInvitation.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.guardianInvitation.create).not.toHaveBeenCalled();
        expect(mockedMailerSend).not.toHaveBeenCalled();
      });

      it('locks the child and the adult inside the transaction before reading the link, and skips the unlocked pre-check', async () => {
        setLivePending();

        await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id);

        // The only link read is the locked one inside the transaction (#664 order, as accept).
        expect(mockPrisma.guardian.findUnique).toHaveBeenCalledTimes(1);
        const lockCall = (mockPrisma.$queryRaw as jest.Mock).mock.calls.find((call: unknown[]) =>
          String((call[0] as string[]).join('')).includes('FOR NO KEY UPDATE')
        );
        expect(lockCall).toBeDefined();
        expect(lockedIds(lockCall as unknown[]).sort()).toEqual([CHILD_ID, 'parent-1'].sort());
        const lockOrder = (mockPrisma.$queryRaw as jest.Mock).mock.invocationCallOrder[
          (mockPrisma.$queryRaw as jest.Mock).mock.calls.indexOf(lockCall as unknown[])
        ];
        expect(lockOrder).toBeLessThan(mockPrisma.guardian.findUnique.mock.invocationCallOrder[0]);
        expect(mockPrisma.guardian.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
          mockPrisma.guardianInvitation.updateMany.mock.invocationCallOrder[0]
        );
      });

      it('refuses when the parent accepted in the race window, without expiring or creating', async () => {
        setLivePending();
        // The locked in-transaction read sees the link the accept just committed.
        (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValueOnce({ id: 'g-1' });

        const err = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id).catch((e) => e);

        expectBadRequestError(err, 'This person is already a guardian of this player');
        expect(mockPrisma.guardianInvitation.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.guardianInvitation.create).not.toHaveBeenCalled();
        expect(mockedMailerSend).not.toHaveBeenCalled();
      });

      it('answers the dedupe 400 when a concurrent resend wins the partial PENDING index (P2002)', async () => {
        setLivePending();
        (mockPrisma.guardianInvitation.create as jest.Mock).mockRejectedValue(
          uniqueViolation('GuardianInvitation_pending_childId_invitedEmail_key')
        );

        const err = await GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id).catch((e) => e);

        expectBadRequestError(err, 'A pending guardian invitation already exists for this email');
        expect(mockedMailerSend).not.toHaveBeenCalled();
      });

      it('propagates a P2002 on another unique (token collision) from the supersede transaction', async () => {
        setLivePending();
        const tokenClash = uniqueViolation('GuardianInvitation_token_key');
        (mockPrisma.guardianInvitation.create as jest.Mock).mockRejectedValue(tokenClash);

        await expect(GuardianService.inviteGuardian(TEAM_ID, CHILD_ID, resend, coach.id)).rejects.toBe(tokenClash);
      });
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
        parent: { id: 'parent-1', name: 'Mom', email: 'mom@test.com', isManaged: false, deletedAt: null },
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
      (mockPrisma.guardianInvitation.findMany as jest.Mock).mockResolvedValue([
        { ...invitationRow(), team: { lineageId: LINEAGE_ID } },
        { ...invitationRow({ id: 'inv-other' }), team: { lineageId: 'other-club' } },
        { ...invitationRow({ id: 'inv-orphan', teamId: null }), team: null },
      ]);

      const result = await GuardianService.listGuardians(TEAM_ID, CHILD_ID, 'coach-1');

      // canResend (#420): same lineage as the caller team (last season's row of
      // this club included); another club's row and a team-less row are listed
      // without it. The lineage join is dropped from the payload.
      expect(result.pendingInvitations.map((r) => [r.id, r.canResend])).toEqual([
        ['inv-1', true],
        ['inv-other', false],
        ['inv-orphan', false],
      ]);
      expect(result.pendingInvitations[0]).not.toHaveProperty('team');
      expect(result.pendingInvitations[0]).not.toHaveProperty('token');

      expect(result.guardians).toEqual([
        expect.objectContaining({ userId: 'parent-1', name: 'Mom', deletedAt: null, email: 'mom@test.com', isPrimary: true }),
      ]);
      // The guardian's own row in the shared user shape (#813).
      expect(mockPrisma.guardian.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: { parent: { select: USER_SUMMARY_WITH_EMAIL_SELECT } } })
      );
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
      (mockPrisma.guardianInvitation.findMany as jest.Mock).mockResolvedValue([
        { ...invitationRow(), team: { lineageId: LINEAGE_ID } },
      ]);

      const result = await GuardianService.listGuardians(TEAM_ID, CHILD_ID, 'parent-1');

      // A guardian cannot resend, even for this club's row.
      expect(result.pendingInvitations[0].canResend).toBe(false);

      expect(result.guardians[0]).not.toHaveProperty('email');
      expect(result.guardians[0].name).toBe('Mom');
      expect(result.guardians[0].deletedAt).toBeNull();
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
      // The child row is locked (#664) before the link is read, so isPrimary
      // is read under the same lock accept and account deletion take.
      const lockCall = (mockPrisma.$queryRaw as jest.Mock).mock.calls.find((call) =>
        (call[0] as TemplateStringsArray).join('?').includes('FOR NO KEY UPDATE')
      );
      expect(lockCall).toBeDefined();
      expect(lockedIds(lockCall as unknown[])).toEqual([CHILD_ID]);
      const lockOrder = (mockPrisma.$queryRaw as jest.Mock).mock.invocationCallOrder[
        (mockPrisma.$queryRaw as jest.Mock).mock.calls.indexOf(lockCall as unknown[])
      ];
      expect(lockOrder).toBeLessThan((mockPrisma.guardian.findUnique as jest.Mock).mock.invocationCallOrder[0]);
      // No permission lookup needed for self-removal
      expect(mockPrisma.teamStaff.findUnique).not.toHaveBeenCalled();
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
        child: { name: 'Kid Smith', deletedAt: null },
        team: { name: 'Lakers' },
        invitedBy: { name: 'Coach', deletedAt: null },
      });

      const result = await GuardianService.getInvitationByToken('tok');

      expect(result).toEqual({
        kind: 'guardian',
        id: 'inv-1',
        status: 'PENDING',
        childName: 'Kid Smith',
        childDeletedAt: null,
        teamName: 'Lakers',
        inviterName: 'Coach',
        inviterDeletedAt: null,
        relationship: 'FATHER',
        expiresAt: expiresAt.toISOString(),
      });
      expect(result).not.toHaveProperty('invitedEmail');
      // Public payload: the inviter's name and tombstone signal, never email.
      expect(mockPrisma.guardianInvitation.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            child: { select: { name: true, deletedAt: true } },
            invitedBy: { select: { name: true, deletedAt: true } },
          }),
        })
      );
    });

    it('carries the deleted inviter tombstone (#813)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue({
        id: 'inv-1',
        status: 'PENDING',
        relationship: 'FATHER',
        expiresAt: new Date(),
        child: { name: 'Kid Smith', deletedAt: null },
        team: { name: 'Lakers' },
        invitedBy: { name: 'Deleted user', deletedAt: new Date('2026-09-01T00:00:00.000Z') },
      });

      const result = await GuardianService.getInvitationByToken('tok');
      expect(result.inviterDeletedAt).toBe('2026-09-01T00:00:00.000Z');
      expect(result.childDeletedAt).toBeNull();
    });

    it('returns teamName null when the team was deleted', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue({
        id: 'inv-1',
        status: 'PENDING',
        relationship: 'FATHER',
        expiresAt: new Date(),
        child: { name: 'Kid Smith', deletedAt: null },
        team: null,
        invitedBy: { name: 'Coach', deletedAt: null },
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
      user: { updateMany: jest.Mock };
      $queryRaw: jest.Mock;
    };

    function setTx(overrides: Partial<{
      updateCount: number;
      existingLink: unknown;
      guardianCount: number;
      memberships: number;
      staffRows: number;
      parentLive: boolean;
      parentTombstoned: boolean;
      promotedCount: number;
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
        user: { updateMany: jest.fn().mockResolvedValue({ count: overrides.promotedCount ?? 1 }) },
        // lockUsers on child + parent (#664, #643): no parent row = erased
        // meanwhile, a deletedAt = tombstoned meanwhile.
        $queryRaw:
          overrides.parentLive === false
            ? jest.fn().mockResolvedValue([])
            : echoLockedRows(overrides.parentTombstoned ? ['parent-1', 'coach-2'] : []),
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
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PLAYER' });
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
      // Guarded on deletedAt (#643): the role write never lands on a tombstone.
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'parent-1', deletedAt: null },
        data: { role: 'PARENT' },
      });
      // One lock statement for child AND parent (#664, #643), before the
      // invitation write: sorted by id so two accepts can never deadlock, and
      // a write lock (not FOR SHARE) that leaves FK inserts on the child free.
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
      expect(sql).toContain('"id" IN (?)');
      expect(sql).toContain('ORDER BY "id"');
      expect(sql).toContain('FOR NO KEY UPDATE');
      expect(lockedIds(tx.$queryRaw.mock.calls[0])).toEqual([CHILD_ID, 'parent-1']);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.guardianInvitation.updateMany.mock.invocationCallOrder[0]
      );
    });

    it('404s and creates no Guardian link when the parent was deleted after it was resolved (#643)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'coach-2', role: 'COACH' });
      const tx = setTx({ parentLive: false });

      try {
        await GuardianService.acceptInvitationByToken('tok');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Account not found');
      }
      expect(tx.guardianInvitation.updateMany).not.toHaveBeenCalled();
      expect(tx.guardian.create).not.toHaveBeenCalled();
      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });

    it('404s and creates no Guardian link when the parent is a tombstone under the lock (#643)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PLAYER' });
      const tx = setTx({ parentTombstoned: true });

      const error = await GuardianService.acceptInvitationByToken('tok').catch((e) => e);

      expectNotFoundError(error, 'Account not found');
      expect(tx.guardianInvitation.updateMany).not.toHaveBeenCalled();
      expect(tx.guardian.create).not.toHaveBeenCalled();
    });

    it('aborts the transaction when the guarded role write updates zero rows (#643)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PLAYER' });
      setTx({ promotedCount: 0 });

      try {
        await GuardianService.acceptInvitationByToken('tok');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Account not found');
      }
    });

    it('is not primary when the child already has a guardian', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-2', role: 'PARENT' });
      setTx({ guardianCount: 1 });

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(result.guardian.isPrimary).toBe(false);
    });

    it('keeps a COACH account as COACH', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'coach-2', role: 'COACH' });
      const tx = setTx();

      await GuardianService.acceptInvitationByToken('tok');

      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.teamMember.count).not.toHaveBeenCalled();
    });

    it('keeps a PLAYER who is rostered somewhere as PLAYER', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'player-2', role: 'PLAYER' });
      const tx = setTx({ memberships: 1 });

      await GuardianService.acceptInvitationByToken('tok');

      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });

    it('keeps a PLAYER who is team staff as PLAYER', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'player-2', role: 'PLAYER' });
      const tx = setTx({ staffRows: 1 });

      await GuardianService.acceptInvitationByToken('tok');

      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });

    it('reuses an existing Guardian link instead of creating a duplicate', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PARENT' });
      const existing = { id: 'g-old', parentId: 'parent-1', childId: CHILD_ID, relationship: 'OTHER', isPrimary: true };
      const tx = setTx({ existingLink: existing });

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(tx.guardian.create).not.toHaveBeenCalled();
      expect(result.guardian.id).toBe('g-old');
    });

    it('resolves the adult with emailEquals (case-insensitive, escaped), never an exact-case lookup (#663)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow({ invitedEmail: 'pat_lee@test.com' }));
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'u1-mixed-case', role: 'COACH' });
      const tx = setTx();

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: emailEquals('pat_lee@test.com'), deletedAt: null },
        select: { id: true, role: true },
      });
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ email: expect.anything() }) })
      );
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(result.guardian.parentId).toBe('u1-mixed-case');
      expect(tx.guardian.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'u1-mixed-case' }) })
      );
    });

    it('creates the PARENT account when none exists for the invited email', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: 'parent-new', role: 'PARENT' });
      setTx();

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'parent@test.com', role: 'PARENT' }) })
      );
      expect(result.guardian.parentId).toBe('parent-new');
    });

    it('reuses the row that won a concurrent create (P2002) instead of failing (#663)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'parent-winner', role: 'PARENT' });
      const p2002 = uniqueViolation('User_email_key');
      (mockPrisma.user.create as jest.Mock).mockRejectedValue(p2002);
      setTx();

      const result = await GuardianService.acceptInvitationByToken('tok');

      expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(2);
      expect(result.guardian.parentId).toBe('parent-winner');
    });

    it('rethrows a create failure that is not P2002', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockRejectedValue(new Error('db down'));
      setTx();

      await expect(GuardianService.acceptInvitationByToken('tok')).rejects.toThrow('db down');
    });

    it('rethrows P2002 when the winner row still cannot be found', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      const p2002 = uniqueViolation('User_email_key');
      (mockPrisma.user.create as jest.Mock).mockRejectedValue(p2002);
      setTx();

      await expect(GuardianService.acceptInvitationByToken('tok')).rejects.toBe(p2002);
    });

    it('returns 400 (not 500) when a concurrent accept already moved it out of PENDING', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PARENT' });
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

    it('acceptInvitation links the verified caller: a mixed-case stored address never creates a second account (#663)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      // assertAddressee reads the caller by id; the stored address differs from
      // invitedEmail only in case, which the exact-case lookup used to miss.
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-1', email: 'PARENT@test.com', role: 'PARENT' });
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'parent-1', role: 'PARENT' });
      const tx = {
        guardianInvitation: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(invitationRow({ status: 'ACCEPTED' })),
        },
        guardian: {
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'g', ...data })),
        },
        user: { updateMany: jest.fn() },
        $queryRaw: echoLockedRows(),
      };
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

      const result = await GuardianService.acceptInvitation('inv-1', 'parent-1');

      expect(result.guardian.id).toBe('g');
      expect(result.guardian.parentId).toBe('parent-1');
      expect(tx.guardian.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: 'parent-1' }) })
      );
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      // The caller is resolved by id, never a second time by email.
      expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'parent-1', deletedAt: null },
        select: { id: true, role: true },
      });
      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });

    it('acceptInvitation throws NotFoundError when the verified caller was deleted in the meantime', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'parent-1', email: 'parent@test.com', role: 'PARENT' });
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      try {
        await GuardianService.acceptInvitation('inv-1', 'parent-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'User not found');
      }
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejectInvitation marks the invitation REJECTED for the addressee', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'parent@test.com' });
      (mockPrisma.guardianInvitation.update as jest.Mock).mockResolvedValue(invitationRow({ status: 'REJECTED' }));

      const result = await GuardianService.rejectInvitation('inv-1', 'parent-1');

      expect(result.status).toBe('REJECTED');
      // Guarded like accept (#726): one conditional UPDATE, only a row still
      // PENDING matches, and the token never comes back.
      expect(mockPrisma.guardianInvitation.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.guardianInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: 'PENDING' },
        data: { status: 'REJECTED' },
        select: expect.not.objectContaining({ token: true }),
      });
      expect(mockPrisma.guardianInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('rejectInvitation answers 400 when a concurrent accept flipped the row after the read (#726)', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'parent@test.com' });
      // The conditional UPDATE matches nothing once the row left PENDING.
      (mockPrisma.guardianInvitation.update as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
          code: 'P2025',
          clientVersion: 'test',
        })
      );

      const error = await GuardianService.rejectInvitation('inv-1', 'parent-1').catch((e) => e);

      expectBadRequestError(error, 'Cannot reject invitation: it is no longer pending');
      expect(mockPrisma.guardian.create).not.toHaveBeenCalled();
      expect(mockPrisma.guardian.deleteMany).not.toHaveBeenCalled();
    });

    it('rejectInvitation propagates an update failure that is not P2025', async () => {
      (mockPrisma.guardianInvitation.findUnique as jest.Mock).mockResolvedValue(invitationRow());
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'parent@test.com' });
      const boom = new Error('connection reset');
      (mockPrisma.guardianInvitation.update as jest.Mock).mockRejectedValue(boom);

      await expect(GuardianService.rejectInvitation('inv-1', 'parent-1')).rejects.toBe(boom);
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

      expect(mockPrisma.teamStaff.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.guardianInvitation.create).toHaveBeenCalledTimes(1);
    });
  });
});
