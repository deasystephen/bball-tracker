/**
 * Replies under a team announcement (#34).
 *
 * One level deep: a reply belongs to an announcement, never to another reply.
 * Anyone who can read the team (`canAccessTeam`: staff, roster players,
 * guardians of players, league admins, ADMIN) may reply; the reply's author or
 * a coach (`canManageTeam`, the flag that posts announcements) may delete.
 *
 * A new reply notifies the announcement's author by push and email, in the
 * background, unless the author replied to their own announcement or turned
 * `notifyOnReplies` off (PATCH /auth/me). Real-time delivery to other readers
 * is out of scope; the app refetches when the thread is opened.
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam } from '../utils/permissions';
import { NotificationService } from './notification-service';
import { logger } from '../utils/logger';
import { mailer } from './mailer';
import { announcementReplyTemplate } from './mailer/templates';

/**
 * No `email`: reply authors are players and guardians, whose addresses are
 * shown only to roster managers elsewhere (CLAUDE.md, emails in payloads).
 * `deletedAt` lets the client render the tombstone label.
 */
export const REPLY_INCLUDE = {
  author: {
    select: {
      id: true,
      name: true,
      profilePictureUrl: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.AnnouncementReplyInclude;

export type AnnouncementReplyWithAuthor = Prisma.AnnouncementReplyGetPayload<{
  include: typeof REPLY_INCLUDE;
}>;

/** What creating a reply needs to know about its announcement. */
const REPLY_TARGET_SELECT = {
  id: true,
  teamId: true,
  authorId: true,
  title: true,
  team: { select: { name: true } },
} satisfies Prisma.AnnouncementSelect;

type ReplyTarget = Prisma.AnnouncementGetPayload<{ select: typeof REPLY_TARGET_SELECT }>;

export interface AnnouncementReplyList {
  replies: AnnouncementReplyWithAuthor[];
  total: number;
  limit: number;
  offset: number;
}

/** Push bodies are one line; the email carries the full text. */
const PUSH_BODY_MAX = 100;

export class AnnouncementReplyService {
  /**
   * Add a reply and notify the announcement's author (background).
   */
  static async createReply(
    announcementId: string,
    data: { body: string },
    userId: string
  ): Promise<AnnouncementReplyWithAuthor> {
    const announcement = await prisma.announcement.findUnique({
      where: { id: announcementId },
      select: REPLY_TARGET_SELECT,
    });
    if (!announcement) {
      throw new NotFoundError('Announcement not found');
    }

    const hasAccess = await canAccessTeam(userId, announcement.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const reply = await prisma.announcementReply.create({
      data: { announcementId, authorId: userId, body: data.body },
      include: REPLY_INCLUDE,
    });

    logger.info('Announcement reply created', {
      replyId: reply.id,
      announcementId,
      teamId: announcement.teamId,
      userId,
    });

    AnnouncementReplyService.notifyAuthor(announcement, reply).catch((err: unknown) => {
      logger.error('Failed to notify announcement author of a reply', {
        error: err instanceof Error ? err.message : String(err),
        replyId: reply.id,
        announcementId,
      });
    });

    return reply;
  }

  /**
   * Push + email to the announcement's author. Skipped when the author
   * replied to themselves, opted out, or no longer has an account. Push and
   * email are independent: one failing never stops the other, and neither
   * failure reaches the caller.
   */
  static async notifyAuthor(announcement: ReplyTarget, reply: AnnouncementReplyWithAuthor): Promise<void> {
    if (announcement.authorId === reply.authorId) return;

    const author = await prisma.user.findUnique({
      where: { id: announcement.authorId },
      select: { id: true, name: true, email: true, notifyOnReplies: true, deletedAt: true },
    });
    if (!author || author.deletedAt || !author.notifyOnReplies) return;

    const replierName = reply.author.name;
    const teamName = announcement.team.name;

    try {
      await NotificationService.sendToUsers([author.id], {
        title: `${teamName}: ${announcement.title}`,
        body: `${replierName}: ${
          reply.body.length > PUSH_BODY_MAX ? reply.body.substring(0, PUSH_BODY_MAX) + '...' : reply.body
        }`,
        data: { teamId: announcement.teamId, announcementId: announcement.id },
      });
    } catch (err) {
      logger.error('Failed to send announcement reply push', {
        error: err instanceof Error ? err.message : String(err),
        replyId: reply.id,
        announcementId: announcement.id,
      });
    }

    if (!author.email) return;
    try {
      await mailer.send({
        template: announcementReplyTemplate,
        to: author.email,
        variables: {
          recipientName: author.name,
          teamName,
          title: announcement.title,
          replierName,
          body: reply.body,
        },
        metadata: {
          userId: reply.authorId,
          event_type: 'announcement.replied',
          teamId: announcement.teamId,
          announcementId: announcement.id,
          replyId: reply.id,
        },
      });
    } catch (err) {
      logger.error('Failed to send announcement reply email', {
        error: err instanceof Error ? err.message : String(err),
        replyId: reply.id,
        announcementId: announcement.id,
      });
    }
  }

  /**
   * The thread, oldest first, paginated (20 per page by default).
   */
  static async listReplies(
    announcementId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<AnnouncementReplyList> {
    const { limit = 20, offset = 0 } = options;

    const announcement = await prisma.announcement.findUnique({
      where: { id: announcementId },
      select: { id: true, teamId: true },
    });
    if (!announcement) {
      throw new NotFoundError('Announcement not found');
    }

    const hasAccess = await canAccessTeam(userId, announcement.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const [total, replies] = await Promise.all([
      prisma.announcementReply.count({ where: { announcementId } }),
      prisma.announcementReply.findMany({
        where: { announcementId },
        include: REPLY_INCLUDE,
        orderBy: { createdAt: 'asc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { replies, total, limit, offset };
  }

  /**
   * Remove a reply: its author, or anyone with `canManageTeam` on the team.
   * A reply that is not under `announcementId` is a 404, not a hint.
   */
  static async deleteReply(announcementId: string, replyId: string, userId: string): Promise<void> {
    const reply = await prisma.announcementReply.findUnique({
      where: { id: replyId },
      select: { id: true, authorId: true, announcementId: true, announcement: { select: { teamId: true } } },
    });
    if (!reply || reply.announcementId !== announcementId) {
      throw new NotFoundError('Reply not found');
    }

    const isAuthor = reply.authorId === userId;
    const canManage = isAuthor ? true : await hasTeamPermission(userId, reply.announcement.teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to delete this reply');
    }

    await prisma.announcementReply.delete({ where: { id: replyId } });

    logger.info('Announcement reply deleted', {
      replyId,
      announcementId,
      teamId: reply.announcement.teamId,
      userId,
      by: isAuthor ? 'author' : 'coach',
    });
  }
}
