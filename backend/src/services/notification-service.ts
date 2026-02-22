/**
 * Push notification service using Expo Push Notifications
 */

import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import prisma from '../models';
import { logger } from '../utils/logger';

const expo = new Expo();

export class NotificationService {
  /**
   * Register a push token for a user
   */
  static async registerToken(userId: string, token: string, platform: string) {
    if (!Expo.isExpoPushToken(token)) {
      throw new Error('Invalid Expo push token');
    }

    return prisma.pushToken.upsert({
      where: { token },
      create: {
        userId,
        token,
        platform,
      },
      update: {
        userId,
        platform,
      },
    });
  }

  /**
   * Remove a push token
   */
  static async removeToken(token: string) {
    return prisma.pushToken.deleteMany({
      where: { token },
    });
  }

  /**
   * Send push notifications to specific users
   */
  static async sendToUsers(
    userIds: string[],
    notification: { title: string; body: string; data?: Record<string, unknown> }
  ) {
    const tokens = await prisma.pushToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });

    if (tokens.length === 0) return [];

    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      sound: 'default' as const,
      title: notification.title,
      body: notification.body,
      data: notification.data || {},
    }));

    return NotificationService.sendMessages(messages);
  }

  /**
   * Send push notifications to all members of a team
   */
  static async sendToTeam(
    teamId: string,
    notification: { title: string; body: string; data?: Record<string, unknown> },
    excludeUserId?: string
  ) {
    // Get all team member and staff user IDs
    const [members, staff] = await Promise.all([
      prisma.teamMember.findMany({
        where: { teamId },
        select: { playerId: true },
      }),
      prisma.teamStaff.findMany({
        where: { teamId },
        select: { userId: true },
      }),
    ]);

    const userIds = new Set([
      ...members.map(m => m.playerId),
      ...staff.map(s => s.userId),
    ]);

    if (excludeUserId) {
      userIds.delete(excludeUserId);
    }

    if (userIds.size === 0) return [];

    return NotificationService.sendToUsers([...userIds], notification);
  }

  /**
   * Internal: send messages via Expo SDK
   */
  private static async sendMessages(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        logger.error('Error sending push notification chunk', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return tickets;
  }
}
