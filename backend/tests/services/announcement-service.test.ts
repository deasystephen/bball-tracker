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

const mockedSendToTeam = NotificationService.sendToTeam as jest.Mock;

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

describe('AnnouncementService', () => {
  beforeEach(() => {
    mockedSendToTeam.mockReset();
    mockedSendToTeam.mockResolvedValue(undefined);
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
