/**
 * AnnouncementReplyService (#34): access rules, delete rules, and the
 * notification triggers (push + email to the announcement's author, honouring
 * the opt-out, never surfacing a failure to the caller).
 */

import { AnnouncementReplyService, REPLY_INCLUDE } from '../../src/services/announcement-reply-service';
import { NotificationService } from '../../src/services/notification-service';
import { canAccessTeam, hasTeamPermission } from '../../src/utils/permissions';
import { mockPrisma } from '../setup';
import { expectForbiddenError, expectNotFoundError } from '../helpers';

jest.mock('../../src/utils/permissions', () => ({
  canAccessTeam: jest.fn(),
  hasTeamPermission: jest.fn(),
}));

jest.mock('../../src/services/notification-service', () => ({
  NotificationService: { sendToUsers: jest.fn() },
}));

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

const mockedCanAccessTeam = canAccessTeam as jest.Mock;
const mockedHasTeamPermission = hasTeamPermission as jest.Mock;
const mockedSendToUsers = NotificationService.sendToUsers as jest.Mock;
const mockedMailerSend = (jest.requireMock('../../src/services/mailer') as unknown as { mailer: { send: jest.Mock } })
  .mailer.send;

const ANNOUNCEMENT_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const COACH_ID = 'coach-1';
const PLAYER_ID = 'player-1';
const REPLY_ID = 'reply-1';

const announcementTarget = {
  id: ANNOUNCEMENT_ID,
  teamId: TEAM_ID,
  authorId: COACH_ID,
  title: 'Practice moved',
  team: { name: 'Lakers' },
};

const coachRow = {
  id: COACH_ID,
  name: 'Frank Vogel',
  email: 'frank@example.test',
  notifyOnReplies: true,
  deletedAt: null,
};

interface ReplyRow {
  id: string;
  announcementId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; profilePictureUrl: string | null; deletedAt: Date | null };
}

const replyRow = (authorId = PLAYER_ID, body = 'See you there'): ReplyRow => ({
  id: REPLY_ID,
  announcementId: ANNOUNCEMENT_ID,
  authorId,
  body,
  createdAt: new Date('2026-10-01T01:00:00Z'),
  author: { id: authorId, name: authorId === COACH_ID ? 'Frank Vogel' : 'LeBron James', profilePictureUrl: null, deletedAt: null },
});

/** Resolves with the rejection reason; fails the test when the promise resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

/** The notification runs in the background; let its awaits settle. */
function flushBackgroundWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AnnouncementReplyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendToUsers.mockResolvedValue([]);
    mockedMailerSend.mockResolvedValue({ messageId: 'fake' });
    mockedCanAccessTeam.mockResolvedValue(true);
    mockedHasTeamPermission.mockResolvedValue(false);
    (mockPrisma.announcement.findUnique as jest.Mock).mockResolvedValue(announcementTarget);
    (mockPrisma.announcementReply.create as jest.Mock).mockResolvedValue(replyRow());
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coachRow);
  });

  describe('createReply', () => {
    it('throws NotFoundError for an unknown announcement before any access check', async () => {
      (mockPrisma.announcement.findUnique as jest.Mock).mockResolvedValue(null);

      expectNotFoundError(await rejection(AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, PLAYER_ID)), 'Announcement not found');
      expect(mockedCanAccessTeam).not.toHaveBeenCalled();
      expect(mockPrisma.announcementReply.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when the caller cannot read the team (403, never 400)', async () => {
      mockedCanAccessTeam.mockResolvedValue(false);

      expectForbiddenError(await rejection(AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, 'stranger')));
      expect(mockedCanAccessTeam).toHaveBeenCalledWith('stranger', TEAM_ID);
      expect(mockPrisma.announcementReply.create).not.toHaveBeenCalled();
    });

    it('creates the reply through the named include and returns it', async () => {
      const reply = await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'See you there' }, PLAYER_ID);

      expect(mockPrisma.announcementReply.create).toHaveBeenCalledWith({
        data: { announcementId: ANNOUNCEMENT_ID, authorId: PLAYER_ID, body: 'See you there' },
        include: REPLY_INCLUDE,
      });
      expect(reply).toMatchObject({ id: REPLY_ID, body: 'See you there' });
      // No address in the payload: reply authors are players and guardians.
      expect(REPLY_INCLUDE.author.select).not.toHaveProperty('email');
    });

    it('sends push and email to the announcement author with the reply', async () => {
      await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'See you there' }, PLAYER_ID);
      await flushBackgroundWork();

      expect(mockedSendToUsers).toHaveBeenCalledTimes(1);
      expect(mockedSendToUsers).toHaveBeenCalledWith([COACH_ID], {
        title: 'Lakers: Practice moved',
        body: 'LeBron James: See you there',
        data: { teamId: TEAM_ID, announcementId: ANNOUNCEMENT_ID },
      });

      expect(mockedMailerSend).toHaveBeenCalledTimes(1);
      expect(mockedMailerSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'frank@example.test',
          variables: {
            recipientName: 'Frank Vogel',
            teamName: 'Lakers',
            title: 'Practice moved',
            replierName: 'LeBron James',
            body: 'See you there',
          },
          metadata: expect.objectContaining({
            userId: PLAYER_ID,
            event_type: 'announcement.replied',
            teamId: TEAM_ID,
            announcementId: ANNOUNCEMENT_ID,
          }),
        })
      );
      expect(mockedMailerSend.mock.calls[0][0].template.name).toBe('announcement-reply');
    });

    it('truncates a long reply in the push body, never in the email', async () => {
      const long = 'y'.repeat(150);
      (mockPrisma.announcementReply.create as jest.Mock).mockResolvedValue(replyRow(PLAYER_ID, long));

      await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: long }, PLAYER_ID);
      await flushBackgroundWork();

      expect(mockedSendToUsers.mock.calls[0][1].body).toBe(`LeBron James: ${'y'.repeat(100)}...`);
      expect(mockedMailerSend.mock.calls[0][0].variables.body).toBe(long);
    });

    it('does not notify an author replying to their own announcement', async () => {
      (mockPrisma.announcementReply.create as jest.Mock).mockResolvedValue(replyRow(COACH_ID));

      await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Correction' }, COACH_ID);
      await flushBackgroundWork();

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockedSendToUsers).not.toHaveBeenCalled();
      expect(mockedMailerSend).not.toHaveBeenCalled();
    });

    it('honours the author opt-out (notifyOnReplies false): neither push nor email', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...coachRow, notifyOnReplies: false });

      await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, PLAYER_ID);
      await flushBackgroundWork();

      expect(mockedSendToUsers).not.toHaveBeenCalled();
      expect(mockedMailerSend).not.toHaveBeenCalled();
    });

    it('skips a deleted author (tombstone) and an author without an address', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...coachRow, deletedAt: new Date() });
      await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, PLAYER_ID);
      await flushBackgroundWork();
      expect(mockedSendToUsers).not.toHaveBeenCalled();
      expect(mockedMailerSend).not.toHaveBeenCalled();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...coachRow, email: null });
      await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, PLAYER_ID);
      await flushBackgroundWork();
      expect(mockedSendToUsers).toHaveBeenCalledTimes(1); // push still goes to the device
      expect(mockedMailerSend).not.toHaveBeenCalled();
    });

    it('still emails when push fails, and still returns the reply when both fail', async () => {
      mockedSendToUsers.mockRejectedValue(new Error('expo down'));
      mockedMailerSend.mockRejectedValue(new Error('ses down'));

      const reply = await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, PLAYER_ID);
      await flushBackgroundWork();

      expect(reply.id).toBe(REPLY_ID);
      expect(mockedSendToUsers).toHaveBeenCalledTimes(1);
      expect(mockedMailerSend).toHaveBeenCalledTimes(1);
    });

    it('swallows a failure in the author lookup itself', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockRejectedValue(new Error('db hiccup'));

      const reply = await AnnouncementReplyService.createReply(ANNOUNCEMENT_ID, { body: 'Hi' }, PLAYER_ID);
      await flushBackgroundWork();

      expect(reply.id).toBe(REPLY_ID);
      expect(mockedSendToUsers).not.toHaveBeenCalled();
    });
  });

  describe('listReplies', () => {
    beforeEach(() => {
      (mockPrisma.announcement.findUnique as jest.Mock).mockResolvedValue({ id: ANNOUNCEMENT_ID, teamId: TEAM_ID });
      (mockPrisma.announcementReply.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.announcementReply.findMany as jest.Mock).mockResolvedValue([replyRow()]);
    });

    it('throws NotFoundError for an unknown announcement', async () => {
      (mockPrisma.announcement.findUnique as jest.Mock).mockResolvedValue(null);
      expectNotFoundError(await rejection(AnnouncementReplyService.listReplies(ANNOUNCEMENT_ID, PLAYER_ID)), 'Announcement not found');
    });

    it('throws ForbiddenError without team access', async () => {
      mockedCanAccessTeam.mockResolvedValue(false);
      expectForbiddenError(await rejection(AnnouncementReplyService.listReplies(ANNOUNCEMENT_ID, 'stranger')));
      expect(mockPrisma.announcementReply.findMany).not.toHaveBeenCalled();
    });

    it('returns the thread oldest first, 20 per page by default', async () => {
      const result = await AnnouncementReplyService.listReplies(ANNOUNCEMENT_ID, PLAYER_ID);

      expect(result).toEqual({ replies: [replyRow()], total: 1, limit: 20, offset: 0 });
      expect(mockPrisma.announcementReply.findMany).toHaveBeenCalledWith({
        where: { announcementId: ANNOUNCEMENT_ID },
        include: REPLY_INCLUDE,
        orderBy: { createdAt: 'asc' },
        take: 20,
        skip: 0,
      });
      expect(mockPrisma.announcementReply.count).toHaveBeenCalledWith({ where: { announcementId: ANNOUNCEMENT_ID } });
    });

    it('applies limit and offset', async () => {
      const result = await AnnouncementReplyService.listReplies(ANNOUNCEMENT_ID, PLAYER_ID, { limit: 5, offset: 40 });

      expect(result).toMatchObject({ limit: 5, offset: 40 });
      expect(mockPrisma.announcementReply.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5, skip: 40 }));
    });
  });

  describe('deleteReply', () => {
    const storedReply = {
      id: REPLY_ID,
      authorId: PLAYER_ID,
      announcementId: ANNOUNCEMENT_ID,
      announcement: { teamId: TEAM_ID },
    };

    beforeEach(() => {
      (mockPrisma.announcementReply.findUnique as jest.Mock).mockResolvedValue(storedReply);
      (mockPrisma.announcementReply.delete as jest.Mock).mockResolvedValue(storedReply);
    });

    it('throws NotFoundError for an unknown reply', async () => {
      (mockPrisma.announcementReply.findUnique as jest.Mock).mockResolvedValue(null);
      expectNotFoundError(await rejection(AnnouncementReplyService.deleteReply(ANNOUNCEMENT_ID, REPLY_ID, PLAYER_ID)), 'Reply not found');
      expect(mockPrisma.announcementReply.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the reply is under a different announcement', async () => {
      expectNotFoundError(await rejection(AnnouncementReplyService.deleteReply('other-announcement', REPLY_ID, PLAYER_ID)), 'Reply not found');
      expect(mockPrisma.announcementReply.delete).not.toHaveBeenCalled();
    });

    it('lets the author delete their own reply without a coach check', async () => {
      await AnnouncementReplyService.deleteReply(ANNOUNCEMENT_ID, REPLY_ID, PLAYER_ID);

      expect(mockedHasTeamPermission).not.toHaveBeenCalled();
      expect(mockPrisma.announcementReply.delete).toHaveBeenCalledWith({ where: { id: REPLY_ID } });
    });

    it('lets a coach (canManageTeam) delete anyone\'s reply on the team', async () => {
      mockedHasTeamPermission.mockResolvedValue(true);

      await AnnouncementReplyService.deleteReply(ANNOUNCEMENT_ID, REPLY_ID, COACH_ID);

      expect(mockedHasTeamPermission).toHaveBeenCalledWith(COACH_ID, TEAM_ID, 'canManageTeam');
      expect(mockPrisma.announcementReply.delete).toHaveBeenCalledWith({ where: { id: REPLY_ID } });
    });

    it('throws ForbiddenError for another member without canManageTeam', async () => {
      mockedHasTeamPermission.mockResolvedValue(false);

      expectForbiddenError(await rejection(AnnouncementReplyService.deleteReply(ANNOUNCEMENT_ID, REPLY_ID, 'teammate')));
      expect(mockPrisma.announcementReply.delete).not.toHaveBeenCalled();
    });
  });
});
