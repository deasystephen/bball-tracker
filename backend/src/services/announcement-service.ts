/**
 * Announcement service for team-wide coach messages
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam } from '../utils/permissions';
import { getTeamAudienceUserIds } from '../utils/team-audience';
import { NotificationService } from './notification-service';
import { logger } from '../utils/logger';
import { mailer } from './mailer';
import { announcementTemplate } from './mailer/templates';

const ANNOUNCEMENT_INCLUDE = {
  author: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
  // Reply count for the list's "N replies" footnote (#34); the thread itself
  // is GET /announcements/:id/replies.
  _count: { select: { replies: true } },
} satisfies Prisma.AnnouncementInclude;

export type AnnouncementWithAuthor = Prisma.AnnouncementGetPayload<{
  include: typeof ANNOUNCEMENT_INCLUDE;
}>;

export interface AnnouncementList {
  announcements: AnnouncementWithAuthor[];
  total: number;
  limit: number;
  offset: number;
}

export class AnnouncementService {
  /**
   * Create a new announcement and send push notifications to team members
   */
  static async createAnnouncement(
    teamId: string,
    data: { title: string; body: string },
    userId: string
  ): Promise<AnnouncementWithAuthor> {
    // Verify team exists
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Only coaches/managers can create announcements
    const canManage = await hasTeamPermission(userId, teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to create announcements');
    }

    const announcement = await prisma.announcement.create({
      data: {
        teamId,
        authorId: userId,
        title: data.title,
        body: data.body,
      },
      include: ANNOUNCEMENT_INCLUDE,
    });

    // Email the team (async, don't block response)
    AnnouncementService.emailAnnouncement(team, announcement).catch((err: unknown) => {
      logger.error('Failed to send announcement emails', {
        error: err instanceof Error ? err.message : String(err),
        announcementId: announcement.id,
      });
    });

    // Send push notification to team members (async, don't block response)
    NotificationService.sendToTeam(
      teamId,
      {
        title: `${team.name}: ${data.title}`,
        body: data.body.length > 100 ? data.body.substring(0, 100) + '...' : data.body,
        data: { teamId, announcementId: announcement.id },
      },
      userId // Exclude the author
    ).catch((err) => {
      logger.error('Failed to send announcement notification', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return announcement;
  }

  /**
   * Email an announcement to the team's audience — players, staff and
   * guardians of players, the same set push goes to (#449) — minus the author
   * and anyone without an address.
   *
   * Sends run one after another, not all at once: with guardians included a
   * single announcement is 30-45 messages, and a concurrent burst that size
   * trips the SES per-second send rate. One failed recipient never stops the
   * rest.
   */
  private static async emailAnnouncement(
    team: { id: string; name: string },
    announcement: AnnouncementWithAuthor
  ): Promise<void> {
    const audienceIds = await getTeamAudienceUserIds(team.id, announcement.authorId);
    if (audienceIds.length === 0) return;

    const recipients = await prisma.user.findMany({
      where: { id: { in: audienceIds }, email: { not: null }, deletedAt: null },
      select: { id: true, name: true, email: true },
    });

    for (const recipient of recipients) {
      if (!recipient.email) continue;
      try {
        await mailer.send({
          template: announcementTemplate,
          to: recipient.email,
          variables: {
            recipientName: recipient.name,
            teamName: team.name,
            title: announcement.title,
            body: announcement.body,
            authorName: announcement.author.name ?? announcement.author.email ?? '',
          },
          metadata: {
            userId: announcement.authorId,
            event_type: 'announcement.created',
            teamId: team.id,
            announcementId: announcement.id,
          },
        });
      } catch (err) {
        logger.error('Failed to send announcement email', {
          error: err instanceof Error ? err.message : String(err),
          announcementId: announcement.id,
          recipientId: recipient.id,
        });
      }
    }
  }

  /**
   * One announcement, for the thread screen and for a push deep link that
   * arrives before the list was ever loaded (#34). Same gate as the list:
   * 404 when it does not exist, 403 without access to its team.
   */
  static async getAnnouncement(announcementId: string, userId: string): Promise<AnnouncementWithAuthor> {
    const announcement = await prisma.announcement.findUnique({
      where: { id: announcementId },
      include: ANNOUNCEMENT_INCLUDE,
    });
    if (!announcement) {
      throw new NotFoundError('Announcement not found');
    }

    const hasAccess = await canAccessTeam(userId, announcement.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    return announcement;
  }

  /**
   * List announcements for a team
   */
  static async listAnnouncements(
    teamId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<AnnouncementList> {
    const { limit = 20, offset = 0 } = options;

    // Verify team exists
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Verify user has access
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const [total, announcements] = await Promise.all([
      prisma.announcement.count({ where: { teamId } }),
      prisma.announcement.findMany({
        where: { teamId },
        include: ANNOUNCEMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { announcements, total, limit, offset };
  }
}
