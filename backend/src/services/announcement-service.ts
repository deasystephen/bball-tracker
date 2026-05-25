/**
 * Announcement service for team-wide coach messages
 */

import prisma from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam } from '../utils/permissions';
import { NotificationService } from './notification-service';
import { logger } from '../utils/logger';
import { mailer } from './mailer';
import { announcementTemplate } from './mailer/templates';

export class AnnouncementService {
  /**
   * Create a new announcement and send push notifications to team members
   */
  static async createAnnouncement(
    teamId: string,
    data: { title: string; body: string },
    userId: string
  ) {
    // Verify team exists (also fetch members for email delivery)
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        members: {
          select: {
            player: {
              select: { id: true, name: true, email: true },
            },
          },
        },
      },
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
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Send announcement emails to team members (fire-and-forget)
    type MemberPlayer = { id: string; name: string | null; email: string | null };
    const recipients = (team.members as Array<{ player: MemberPlayer }>)
      .map((m) => m.player)
      .filter((p): p is MemberPlayer & { email: string } => p.id !== userId && p.email !== null);

    for (const recipient of recipients) {
      if (!recipient.email) continue;
      mailer
        .send({
          template: announcementTemplate,
          to: recipient.email,
          variables: {
            recipientName: recipient.name ?? recipient.email,
            teamName: team.name,
            title: data.title,
            body: data.body,
            authorName: announcement.author.name ?? announcement.author.email ?? '',
          },
          metadata: {
            userId,
            event_type: 'announcement.created',
            teamId,
            announcementId: announcement.id,
          },
        })
        .catch((err: unknown) => {
          logger.error('Failed to send announcement email', {
            error: err instanceof Error ? err.message : String(err),
            announcementId: announcement.id,
            recipientId: recipient.id,
          });
        });
    }

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
   * List announcements for a team
   */
  static async listAnnouncements(
    teamId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ) {
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
        include: {
          author: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { announcements, total, limit, offset };
  }
}
