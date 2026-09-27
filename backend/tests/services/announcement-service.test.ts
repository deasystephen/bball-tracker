/**
 * Unit tests for AnnouncementService.
 *
 * NotificationService.sendToTeam is mocked so we can verify the fire-and-forget
 * contract without exercising the push stack. We still assert that the
 * announcement service does not await that call (i.e. the rejection is
 * swallowed via .catch and does not surface to the caller).
 */

import { AnnouncementService } from '../../src/services/announcement-service';
import { NotificationService } from '../../src/services/notification-service';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach, createTeam } from '../factories';
import {
  expectForbiddenError,
  expectNotFoundError,
} from '../helpers';

jest.mock('../../src/services/notification-service', () => ({
  NotificationService: {
    sendToTeam: jest.fn(),
  },
}));

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

const mockedSendToTeam = NotificationService.sendToTeam as jest.Mock;
const mockedMailerSend = (jest.requireMock('../../src/services/mailer') as unknown as { mailer: { send: jest.Mock } }).mailer.send;

function setSystemAdmin(): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createAdmin());
}

function setNoAccess(): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce(null); // permissions helper team lookup
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
  (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
}

/** Email goes out in the background; let that chain of awaits run to completion. */
function flushBackgroundWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AnnouncementService', () => {
  beforeEach(() => {
    mockedSendToTeam.mockReset();
    mockedSendToTeam.mockResolvedValue(undefined);
    mockedMailerSend.mockReset();
    mockedMailerSend.mockResolvedValue({ messageId: 'fake' });
    // An empty audience by default: email is background work every
    // createAnnouncement starts, whatever the test is about.
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);
  });

  describe('createAnnouncement', () => {
    it('throws NotFoundError when the team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce(null);

      try {
        await AnnouncementService.createAnnouncement(
          'missing',
          { title: 'T', body: 'B' },
          'user-1'
        );
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
      expect(mockPrisma.announcement.create).not.toHaveBeenCalled();
      expect(mockedSendToTeam).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when user lacks canManageTeam', async () => {
      const team = createTeam();
      // service lookup
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
        name: team.name,
        members: [],
      });
      setNoAccess();

      try {
        await AnnouncementService.createAnnouncement(
          team.id,
          { title: 'T', body: 'B' },
          'user-1'
        );
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(
          err,
          'You do not have permission to create announcements'
        );
      }
      expect(mockPrisma.announcement.create).not.toHaveBeenCalled();
    });

    it('creates the announcement and fires a push notification with a truncated body', async () => {
      const team = createTeam({ name: 'Hoops' });
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
        name: team.name,
        members: [],
      });
      // permissions helper: system admin short-circuits
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);

      const longBody = 'x'.repeat(150);
      const announcement = {
        id: 'a1',
        teamId: team.id,
        authorId: admin.id,
        title: 'Game moved',
        body: longBody,
        author: { id: admin.id, name: admin.name, email: admin.email },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      (mockPrisma.announcement.create as jest.Mock).mockResolvedValue(announcement);

      const result = await AnnouncementService.createAnnouncement(
        team.id,
        { title: 'Game moved', body: longBody },
        admin.id
      );

      expect(result).toEqual(announcement);
      expect(mockPrisma.announcement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            teamId: team.id,
            authorId: admin.id,
            title: 'Game moved',
            body: longBody,
          },
        })
      );
      expect(mockedSendToTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({
          title: 'Hoops: Game moved',
          // 100 chars + ellipsis
          body: 'x'.repeat(100) + '...',
          data: { teamId: team.id, announcementId: 'a1' },
        }),
        admin.id
      );
    });

    it('sends the full body when it is short enough', async () => {
      const team = createTeam({ name: 'Hoops' });
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
        name: team.name,
        members: [],
      });
      setSystemAdmin();

      const shortBody = 'quick update';
      (mockPrisma.announcement.create as jest.Mock).mockResolvedValue({
        id: 'a2',
        teamId: team.id,
        authorId: admin.id,
        title: 'Hey',
        body: shortBody,
        author: { id: admin.id, name: admin.name, email: admin.email },
      });

      await AnnouncementService.createAnnouncement(
        team.id,
        { title: 'Hey', body: shortBody },
        admin.id
      );

      expect(mockedSendToTeam).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ body: shortBody }),
        admin.id
      );
    });

    it('does not surface push notification failures to the caller', async () => {
      const team = createTeam();
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
        name: team.name,
        members: [],
      });
      setSystemAdmin();
      (mockPrisma.announcement.create as jest.Mock).mockResolvedValue({
        id: 'a3',
        teamId: team.id,
        authorId: admin.id,
        title: 't',
        body: 'b',
        author: { id: admin.id, name: admin.name, email: admin.email },
      });
      mockedSendToTeam.mockRejectedValueOnce(new Error('push down'));

      await expect(
        AnnouncementService.createAnnouncement(
          team.id,
          { title: 't', body: 'b' },
          admin.id
        )
      ).resolves.toMatchObject({ id: 'a3' });

      // let the microtask drain so the .catch runs
      await Promise.resolve();
    });

    describe('email audience (#449)', () => {
      const team = createTeam({ name: 'Hoops' });
      const admin = createAdmin();

      /** Stub the announcement row and the three audience queries. */
      function setAudience(audience: {
        memberIds?: string[];
        staffIds?: string[];
        guardianParentIds?: string[];
        author?: { name: string | null; email: string | null };
      }): void {
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
          id: team.id,
          name: team.name,
        });
        setSystemAdmin();
        (mockPrisma.announcement.create as jest.Mock).mockResolvedValue({
          id: 'a5',
          teamId: team.id,
          authorId: admin.id,
          title: 'Practice',
          body: 'See you there',
          author: { id: admin.id, name: admin.name, email: admin.email, ...audience.author },
        });
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue(
          (audience.memberIds ?? []).map((playerId) => ({ playerId }))
        );
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue(
          (audience.staffIds ?? []).map((userId) => ({ userId }))
        );
        (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue(
          (audience.guardianParentIds ?? []).map((parentId) => ({ parentId }))
        );
      }

      function announce(): Promise<unknown> {
        return AnnouncementService.createAnnouncement(
          team.id,
          { title: 'Practice', body: 'See you there' },
          admin.id
        );
      }

      it('emails players, staff and guardians of players, never the author', async () => {
        setAudience({
          // The author is also rostered and on staff: excluded either way.
          memberIds: ['p1', 'p2', admin.id],
          staffIds: [admin.id, 'assistant'],
          // `assistant` is also a parent: one recipient, not two.
          guardianParentIds: ['mom', 'assistant'],
        });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { id: 'p1', name: 'Alice', email: 'alice@test.com' },
          { id: 'assistant', name: 'Assistant', email: 'assistant@test.com' },
          { id: 'mom', name: 'Mom', email: 'mom@test.com' },
        ]);

        await announce();
        await flushBackgroundWork();

        expect(mockPrisma.guardian.findMany).toHaveBeenCalledWith({
          where: { childId: { in: ['p1', 'p2', admin.id] } },
          select: { parentId: true },
        });
        // Addressless (managed) players and tombstones are filtered in the query.
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['p1', 'p2', 'assistant', 'mom'] },
            email: { not: null },
            deletedAt: null,
          },
          select: { id: true, name: true, email: true },
        });

        expect(mockedMailerSend.mock.calls.map((c) => c[0].to)).toEqual([
          'alice@test.com',
          'assistant@test.com',
          'mom@test.com',
        ]);
        expect(mockedMailerSend.mock.calls[2][0]).toMatchObject({
          variables: {
            recipientName: 'Mom',
            teamName: 'Hoops',
            title: 'Practice',
            body: 'See you there',
            authorName: admin.name,
          },
          metadata: {
            userId: admin.id,
            event_type: 'announcement.created',
            teamId: team.id,
            announcementId: 'a5',
          },
        });
      });

      it('falls back to the author email, then to an empty author name', async () => {
        setAudience({ memberIds: ['p1'], author: { name: null, email: 'coach@test.com' } });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { id: 'p1', name: 'Alice', email: 'alice@test.com' },
        ]);
        await announce();
        await flushBackgroundWork();
        expect(mockedMailerSend.mock.calls[0][0].variables.authorName).toBe('coach@test.com');

        mockedMailerSend.mockClear();
        setAudience({ memberIds: ['p1'], author: { name: null, email: null } });
        await announce();
        await flushBackgroundWork();
        expect(mockedMailerSend.mock.calls[0][0].variables.authorName).toBe('');
      });

      it('sends nothing, and looks nobody up, when the author is the whole audience', async () => {
        setAudience({ memberIds: [admin.id], staffIds: [admin.id] });

        await announce();
        await flushBackgroundWork();

        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(mockedMailerSend).not.toHaveBeenCalled();
      });

      it('skips a row that comes back without an address', async () => {
        setAudience({ memberIds: ['p1', 'p2'] });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { id: 'p1', name: 'NoEmail', email: null },
          { id: 'p2', name: 'Bob', email: 'bob@test.com' },
        ]);

        await announce();
        await flushBackgroundWork();

        expect(mockedMailerSend.mock.calls.map((c) => c[0].to)).toEqual(['bob@test.com']);
      });

      it('keeps sending after one recipient fails, and never surfaces the failure', async () => {
        setAudience({ memberIds: ['p1', 'p2'] });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { id: 'p1', name: 'Alice', email: 'alice@test.com' },
          { id: 'p2', name: 'Bob', email: 'bob@test.com' },
        ]);
        mockedMailerSend.mockRejectedValueOnce(new Error('SES down'));
        mockedMailerSend.mockRejectedValueOnce('throttled');

        await expect(announce()).resolves.toMatchObject({ id: 'a5' });
        await flushBackgroundWork();

        expect(mockedMailerSend).toHaveBeenCalledTimes(2);
      });

      it('sends one at a time, so a large team cannot burst past the SES send rate', async () => {
        setAudience({ memberIds: ['p1', 'p2'] });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { id: 'p1', name: 'Alice', email: 'alice@test.com' },
          { id: 'p2', name: 'Bob', email: 'bob@test.com' },
        ]);
        let releaseFirst: (value: { messageId: string }) => void = () => undefined;
        mockedMailerSend.mockImplementationOnce(
          () => new Promise((resolve) => { releaseFirst = resolve; })
        );

        await announce();
        await flushBackgroundWork();
        expect(mockedMailerSend).toHaveBeenCalledTimes(1);

        releaseFirst({ messageId: 'first' });
        await flushBackgroundWork();
        expect(mockedMailerSend).toHaveBeenCalledTimes(2);
      });

      it('does not surface a failure to resolve the audience', async () => {
        setAudience({});
        (mockPrisma.teamMember.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

        await expect(announce()).resolves.toMatchObject({ id: 'a5' });
        await flushBackgroundWork();

        expect(mockedMailerSend).not.toHaveBeenCalled();

        (mockPrisma.teamMember.findMany as jest.Mock).mockRejectedValue('db down');
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({ id: team.id, name: team.name });
        await expect(announce()).resolves.toMatchObject({ id: 'a5' });
        await flushBackgroundWork();
      });
    });
  });

  describe('listAnnouncements', () => {
    it('throws NotFoundError when the team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce(null);
      try {
        await AnnouncementService.listAnnouncements('missing', 'user-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
    });

    it('throws ForbiddenError when user has no team access', async () => {
      const team = createTeam();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
      });
      setNoAccess();

      try {
        await AnnouncementService.listAnnouncements(team.id, 'user-1');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have access to this team');
      }
    });

    it('returns pagination envelope with defaults', async () => {
      const team = createTeam();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
      });
      setSystemAdmin();
      (mockPrisma.announcement.count as jest.Mock).mockResolvedValue(42);
      const rows = [
        { id: 'a1', title: 'A', body: 'b', teamId: team.id },
        { id: 'a2', title: 'B', body: 'b', teamId: team.id },
      ];
      (mockPrisma.announcement.findMany as jest.Mock).mockResolvedValue(rows);

      const result = await AnnouncementService.listAnnouncements(
        team.id,
        'admin-1'
      );

      expect(result).toEqual({
        announcements: rows,
        total: 42,
        limit: 20,
        offset: 0,
      });

      const findArgs = (mockPrisma.announcement.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toEqual({ teamId: team.id });
      expect(findArgs.take).toBe(20);
      expect(findArgs.skip).toBe(0);
      expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('honors custom limit/offset', async () => {
      const team = createTeam();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValueOnce({
        id: team.id,
      });
      setSystemAdmin();
      (mockPrisma.announcement.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.announcement.findMany as jest.Mock).mockResolvedValue([]);

      const result = await AnnouncementService.listAnnouncements(
        team.id,
        'admin-1',
        { limit: 5, offset: 10 }
      );

      expect(result.limit).toBe(5);
      expect(result.offset).toBe(10);
      const findArgs = (mockPrisma.announcement.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.take).toBe(5);
      expect(findArgs.skip).toBe(10);
    });
  });
});
