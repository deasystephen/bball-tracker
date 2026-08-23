/**
 * Push notification service using Expo Push Notifications
 */

import { Expo, ExpoPushMessage, ExpoPushTicket, ExpoPushReceipt } from 'expo-server-sdk';
import { Prisma, PushToken } from '@prisma/client';
import prisma from '../models';
import { logger } from '../utils/logger';
import { ConflictError } from '../utils/errors';

const expo = new Expo();

/**
 * A push token bound to a *different* user may only be rebound to the caller
 * once the existing binding is older than this (audit: push-token hijack,
 * role matrix B2.9). Current builds unregister on logout, so a fresh row
 * belonging to someone else means the device is still theirs; an old row is
 * a leftover from a build that never called `DELETE /auth/push-token`.
 */
export const PUSH_TOKEN_REBIND_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Expo recommends polling receipts ~15 minutes after sending; APNs/FCM
 * errors such as DeviceNotRegistered only surface there (audit #60).
 */
const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;

/** Receipt/ticket error codes that mean the token will never work again. */
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered']);

export class NotificationService {
  /**
   * Register a push token for a user.
   *
   * Expo push tokens identify a device, not an account, so the same token can
   * legitimately move between users on a shared device. But because the row
   * is unique on `token`, a blind upsert let any authenticated user re-point
   * another user's device to their own account and receive their
   * notifications. Rules:
   *
   * - token unknown, or already bound to the caller → upsert (refreshes
   *   `platform` / `updatedAt`).
   * - token bound to a different user and that binding was touched within
   *   the last 24h → **409 Conflict**; the previous owner must unregister
   *   (logout does this) first.
   * - token bound to a different user and stale (> 24h) → rebind to the
   *   caller (old build that never unregistered).
   */
  static async registerToken(userId: string, token: string, platform: string): Promise<PushToken> {
    if (!Expo.isExpoPushToken(token)) {
      throw new Error('Invalid Expo push token');
    }

    const existing = await prisma.pushToken.findUnique({ where: { token } });

    if (existing && existing.userId !== userId) {
      const ageMs = Date.now() - existing.updatedAt.getTime();
      if (ageMs < PUSH_TOKEN_REBIND_AFTER_MS) {
        logger.warn('Refused to rebind push token registered to another user', {
          tokenOwnerId: existing.userId,
          callerId: userId,
        });
        throw new ConflictError('Push token is registered to another account');
      }

      logger.info('Rebinding stale push token to a new user', {
        previousOwnerId: existing.userId,
        callerId: userId,
      });
      return prisma.pushToken.update({
        where: { token },
        data: { userId, platform },
      });
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
   * Remove a push token owned by the given user.
   *
   * Scoped to `userId` so a caller can only unregister their own device —
   * previously any authenticated user could delete anyone's token by value
   * (audit #47). Returns `{ count: 0 }` when the token exists but belongs to
   * someone else, which callers treat as a no-op.
   */
  static async removeToken(userId: string, token: string): Promise<Prisma.BatchPayload> {
    return prisma.pushToken.deleteMany({
      where: { token, userId },
    });
  }

  /**
   * Send push notifications to specific users
   */
  static async sendToUsers(
    userIds: string[],
    notification: { title: string; body: string; data?: Record<string, unknown> }
  ): Promise<ExpoPushTicket[]> {
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
  ): Promise<ExpoPushTicket[]> {
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
   * Delete push tokens Expo/APNs/FCM reported as permanently dead.
   */
  static async pruneDeadTokens(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const result = await prisma.pushToken.deleteMany({ where: { token: { in: tokens } } });
    if (result.count > 0) {
      logger.info('Pruned unregistered push tokens', { count: result.count });
    }
    return result.count;
  }

  /**
   * Fetch receipts for the given ticket ids and prune tokens whose receipt
   * says DeviceNotRegistered. Exposed for tests and for callers that want to
   * poll explicitly; `sendMessages` schedules it automatically.
   */
  static async checkReceipts(ticketToToken: Map<string, string>): Promise<number> {
    const ids = [...ticketToToken.keys()];
    if (ids.length === 0) return 0;

    const dead: string[] = [];
    for (const chunk of expo.chunkPushNotificationReceiptIds(ids)) {
      let receipts: Record<string, ExpoPushReceipt>;
      try {
        receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      } catch (error) {
        logger.error('Error fetching push receipts', {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.status !== 'error') continue;
        const token = ticketToToken.get(id);
        const code = receipt.details?.error;
        logger.warn('Push receipt error', { code, message: receipt.message });
        if (token && code && DEAD_TOKEN_ERRORS.has(code)) {
          dead.push(token);
        }
      }
    }

    return NotificationService.pruneDeadTokens(dead);
  }

  /**
   * Internal: send messages via Expo SDK. Tickets are inspected immediately
   * (Expo rejects tokens it already knows are dead at send time) and a receipt
   * check is scheduled for the rest.
   */
  private static async sendMessages(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    const dead: string[] = [];
    const ticketToToken = new Map<string, string>();

    for (const chunk of chunks) {
      let ticketChunk: ExpoPushTicket[];
      try {
        ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        logger.error('Error sending push notification chunk', {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      tickets.push(...ticketChunk);

      // Tickets come back in the same order as the messages in the chunk.
      ticketChunk.forEach((ticket, i) => {
        const to = chunk[i]?.to;
        const token = Array.isArray(to) ? to[0] : to;
        if (!token) return;
        if (ticket.status === 'ok') {
          ticketToToken.set(ticket.id, token);
        } else if (ticket.details?.error && DEAD_TOKEN_ERRORS.has(ticket.details.error)) {
          dead.push(token);
        }
      });
    }

    if (dead.length > 0) {
      await NotificationService.pruneDeadTokens(dead).catch((error: unknown) => {
        logger.error('Failed to prune dead push tokens', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (ticketToToken.size > 0) {
      // Fire-and-forget; `unref` so a pending check never holds the process open.
      const timer = setTimeout(() => {
        NotificationService.checkReceipts(ticketToToken).catch((error: unknown) => {
          logger.error('Push receipt check failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, RECEIPT_CHECK_DELAY_MS);
      timer.unref();
    }

    return tickets;
  }
}
