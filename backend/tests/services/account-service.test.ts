/**
 * AccountService — account deletion (#444, docs/plans/account-deletion.md).
 *
 * Mocked-Prisma coverage of the transaction's branches and the post-commit
 * best-effort steps. The real-Postgres suite
 * (tests/integration/account-deletion.db.test.ts) proves the row-level
 * outcomes, rollback and concurrency; this file proves the decision logic.
 */
import { mockPrisma } from '../setup';
import {
  AccountService,
  DELETED_LEAGUE_NAME,
  DELETED_USER_NAME,
} from '../../src/services/account-service';
import { WorkOSService } from '../../src/services/workos-service';
import { deletePreviousAvatar } from '../../src/services/upload-service';
import { captureException } from '../../src/utils/sentry';
import { ForbiddenError, LastHeadCoachError, NotFoundError } from '../../src/utils/errors';

jest.mock('../../src/services/workos-service');
jest.mock('../../src/services/upload-service', () => ({
  deletePreviousAvatar: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));

const mockWorkOS = WorkOSService as jest.Mocked<typeof WorkOSService>;
const mockDeleteAvatar = deletePreviousAvatar as jest.Mock;
const mockCapture = captureException as jest.Mock;

const USER_ID = '11111111-1111-4111-a111-111111111111';

interface LockedRow {
  id: string;
  email: string | null;
  workosUserId: string | null;
  isManaged: boolean;
  profilePictureUrl: string | null;
  deletedAt: Date | null;
}

function lockedRow(overrides: Partial<Omit<LockedRow, 'id'>> = {}): LockedRow {
  return {
    id: USER_ID,
    email: 'gone@example.com',
    workosUserId: 'workos_1',
    isManaged: false,
    profilePictureUrl: null,
    deletedAt: null,
    ...overrides,
  };
}

/** Every purge call resolves; tests override what they care about. */
function armHappyPath(row: LockedRow = lockedRow()): void {
  (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([row]);
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  (mockPrisma.user.update as jest.Mock).mockResolvedValue({ id: USER_ID });
  for (const model of ['pushToken', 'calendarFeedToken', 'teamStaff', 'gameRsvp', 'leagueAdmin', 'guardian'] as const) {
    (mockPrisma[model].deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
  }
  (mockPrisma.teamInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  (mockPrisma.guardianInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  mockWorkOS.deleteUser.mockResolvedValue(undefined);
}

describe('AccountService.deleteAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('locks the row, purges, tombstones, then deletes the avatar and the WorkOS user', async () => {
    armHappyPath(lockedRow({ profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/u/a.jpg' }));

    const result = await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' });

    expect(result).toEqual({ success: true, identityDeleted: true, adminlessLeagueIds: [] });
    // Lock first
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    // Purge
    for (const model of ['pushToken', 'calendarFeedToken', 'teamStaff', 'gameRsvp', 'leagueAdmin'] as const) {
      expect(mockPrisma[model].deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    }
    expect(mockPrisma.guardian.deleteMany).toHaveBeenCalledWith({ where: { parentId: USER_ID } });
    expect(mockPrisma.guardian.deleteMany).toHaveBeenCalledWith({ where: { childId: USER_ID } });
    expect(mockPrisma.teamInvitation.updateMany).toHaveBeenCalledWith({
      where: { playerId: USER_ID, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    expect(mockPrisma.guardianInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING',
        OR: [{ childId: USER_ID }, { invitedEmail: { equals: 'gone@example.com', mode: 'insensitive' } }],
      },
      data: { status: 'EXPIRED' },
    });
    // D17: every matching invitedEmail is scrubbed, not just PENDING rows
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { managedById: USER_ID },
      data: { managedById: null },
    });
    // Tombstone
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: expect.objectContaining({
        workosUserId: null,
        email: null,
        name: DELETED_USER_NAME,
        emailVerified: false,
        profilePictureUrl: null,
        managedById: null,
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
        deletedAt: expect.any(Date),
      }),
    });
    // After commit
    expect(mockDeleteAvatar).toHaveBeenCalledWith('https://bucket.s3.amazonaws.com/avatars/u/a.jpg', null);
    expect(mockWorkOS.deleteUser).toHaveBeenCalledWith('workos_1');
  });

  it('answers 404 for an unknown or already-deleted account and writes nothing', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    await expect(AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' })).rejects.toBeInstanceOf(
      NotFoundError
    );

    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([lockedRow({ deletedAt: new Date() })]);
    await expect(AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' })).rejects.toBeInstanceOf(
      NotFoundError
    );

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.teamStaff.deleteMany).not.toHaveBeenCalled();
    expect(mockWorkOS.deleteUser).not.toHaveBeenCalled();
  });

  it('blocks a sole head coach of an active-season team with a 400 that lists the teams, and writes nothing', async () => {
    armHappyPath();
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
      { teamId: 't1', userId: USER_ID, team: { name: 'Lakers' } },
      { teamId: 't2', userId: USER_ID, team: { name: 'Bulls' } },
      { teamId: 't2', userId: 'co-head', team: { name: 'Bulls' } },
    ]);

    const error = await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' }).catch((e) => e);

    expect(error).toBeInstanceOf(LastHeadCoachError);
    expect((error as LastHeadCoachError).body()).toEqual({
      error: expect.stringContaining('only Head Coach'),
      code: 'last_head_coach',
      teams: [{ id: 't1', name: 'Lakers' }],
    });
    // The check is scoped to active seasons (D4)
    expect(mockPrisma.teamStaff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ team: expect.objectContaining({ season: { isActive: true } }) }),
      })
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.teamStaff.deleteMany).not.toHaveBeenCalled();
    expect(mockWorkOS.deleteUser).not.toHaveBeenCalled();
  });

  it('operator mode skips the owner gate but keeps the last-head-coach rule', async () => {
    armHappyPath();
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
      { teamId: 't1', userId: USER_ID, team: { name: 'Lakers' } },
    ]);

    await expect(
      AccountService.deleteAccount(USER_ID, { actorId: 'operator', mode: 'operator' })
    ).rejects.toBeInstanceOf(LastHeadCoachError);
  });

  describe('guardian mode (D5, re-checked under the lock)', () => {
    it('deletes a managed, unclaimed child without running the head-coach query', async () => {
      armHappyPath(lockedRow({ email: null, workosUserId: null, isManaged: true }));

      const result = await AccountService.deleteAccount(USER_ID, { actorId: 'parent-1', mode: 'guardian' });

      expect(result.identityDeleted).toBe(false);
      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
      expect(mockWorkOS.deleteUser).not.toHaveBeenCalled();
      // No email → nothing to scrub on GuardianInvitation.invitedEmail
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) })
      );
    });

    it.each([
      ['claimed since the route check', lockedRow({ isManaged: true, workosUserId: 'workos_child' })],
      ['not a managed record', lockedRow({ isManaged: false, workosUserId: null })],
    ])('refuses (403) a child that is %s and writes nothing', async (_label, row) => {
      armHappyPath(row);

      await expect(
        AccountService.deleteAccount(USER_ID, { actorId: 'parent-1', mode: 'guardian' })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.guardian.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('promotes the next guardian to primary for every child the user was primary guardian of', async () => {
    armHappyPath();
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([
      { childId: 'kid-1', isPrimary: true },
      { childId: 'kid-2', isPrimary: false },
    ]);
    (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue({ id: 'g-next' });

    await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' });

    expect(mockPrisma.guardian.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.guardian.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { childId: 'kid-1' } })
    );
    expect(mockPrisma.guardian.update).toHaveBeenCalledWith({ where: { id: 'g-next' }, data: { isPrimary: true } });
  });

  describe('personal league (D16)', () => {
    it('renames the container and drops the owner marker when it still holds teams', async () => {
      armHappyPath();
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ id: 'pl-1' });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(2);

      await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' });

      expect(mockPrisma.league.update).toHaveBeenCalledWith({
        where: { id: 'pl-1' },
        data: { name: DELETED_LEAGUE_NAME, personalOwnerId: null },
      });
      expect(mockPrisma.league.delete).not.toHaveBeenCalled();
    });

    it('deletes the container outright when no team references it', async () => {
      armHappyPath();
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ id: 'pl-1' });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);

      await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' });

      expect(mockPrisma.league.delete).toHaveBeenCalledWith({ where: { id: 'pl-1' } });
      expect(mockPrisma.league.update).not.toHaveBeenCalled();
    });
  });

  it('reports real leagues left without an admin, excluding the personal league (D18)', async () => {
    armHappyPath();
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([
      { leagueId: 'real-1' },
      { leagueId: 'real-2' },
      { leagueId: 'pl-1' },
    ]);
    (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ id: 'pl-1' });
    (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);
    (mockPrisma.leagueAdmin.count as jest.Mock).mockImplementation(async ({ where }: { where: { leagueId: string } }) =>
      where.leagueId === 'real-1' ? 0 : 3
    );

    const result = await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' });

    expect(result.adminlessLeagueIds).toEqual(['real-1']);
  });

  describe('after commit (best-effort)', () => {
    it('still succeeds when WorkOS deletion fails, reports identityDeleted:false, and revokes the session if known', async () => {
      armHappyPath();
      mockWorkOS.deleteUser.mockRejectedValue(new Error('workos down'));
      mockWorkOS.revokeSession.mockResolvedValue(undefined);

      const result = await AccountService.deleteAccount(USER_ID, {
        actorId: USER_ID,
        mode: 'self',
        sessionId: 'sess_1',
      });

      expect(result.identityDeleted).toBe(false);
      expect(mockCapture).toHaveBeenCalledWith(expect.any(Error), { flow: 'account-delete', userId: USER_ID });
      expect(mockWorkOS.revokeSession).toHaveBeenCalledWith('sess_1');
      // The tombstone was written regardless
      expect(mockPrisma.user.update).toHaveBeenCalled();
    });

    it('survives the revoke fallback failing too (both errors logged, request still succeeds)', async () => {
      armHappyPath();
      mockWorkOS.deleteUser.mockRejectedValue(new Error('workos down'));
      mockWorkOS.revokeSession.mockRejectedValue(new Error('still down'));

      const result = await AccountService.deleteAccount(USER_ID, {
        actorId: USER_ID,
        mode: 'self',
        sessionId: 'sess_1',
      });

      expect(result.identityDeleted).toBe(false);
      expect(mockWorkOS.revokeSession).toHaveBeenCalledWith('sess_1');
    });

    it('skips the WorkOS call for a row that never had a login', async () => {
      armHappyPath(lockedRow({ workosUserId: null }));

      const result = await AccountService.deleteAccount(USER_ID, { actorId: USER_ID, mode: 'self' });

      expect(result.identityDeleted).toBe(false);
      expect(mockWorkOS.deleteUser).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    });
  });
});

describe('AccountService.exportUserData', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws 404 for an unknown user', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(AccountService.exportUserData(USER_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns every section the runbook lists and never the WorkOS id', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: USER_ID,
      email: 'me@example.com',
      name: 'Me',
      role: 'COACH',
      emailVerified: true,
      profilePictureUrl: null,
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
      isManaged: false,
      managedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    for (const model of [
      'teamMember', 'teamStaff', 'leagueAdmin', 'guardian', 'teamInvitation', 'guardianInvitation',
      'gameRsvp', 'gameEvent', 'playerStats', 'pushToken', 'calendarFeedToken', 'announcement',
    ] as const) {
      (mockPrisma[model].findMany as jest.Mock).mockResolvedValue([]);
    }
    (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

    const data = await AccountService.exportUserData(USER_ID);

    expect(Object.keys(data).sort()).toEqual(
      [
        'announcements', 'calendarFeedTokens', 'exportedAt', 'gameEvents', 'gameRsvps', 'guardianInvitations',
        'guardiansAsChild', 'guardiansAsParent', 'leagueAdmins', 'personalLeague', 'playerStats', 'pushTokens',
        'receivedInvitations', 'sentGuardianInvitations', 'sentInvitations', 'teamMembers', 'teamStaff', 'user',
      ].sort()
    );
    expect(data.user).not.toHaveProperty('workosUserId');
    // Guardian invitations are matched by child id AND by the user's own email
    expect(mockPrisma.guardianInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ childId: USER_ID }, { invitedEmail: { equals: 'me@example.com', mode: 'insensitive' } }] },
      })
    );
  });
});
