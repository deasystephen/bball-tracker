/**
 * Unit tests for NotificationService
 *
 * Covers token registration/removal, user-targeted sends, team-targeted sends
 * (with member+staff fan-out and exclusion), empty-audience short-circuits,
 * and error swallowing in the Expo send loop.
 *
 * The `expo-server-sdk` module is mocked via `moduleNameMapper` in
 * `jest.config.js` → `tests/__mocks__/expo-server-sdk.js`. The mock's
 * `Expo.isExpoPushToken` returns true for strings starting with
 * `ExponentPushToken[`.
 */

import { Expo } from 'expo-server-sdk';
import { NotificationService } from '../../src/services/notification-service';
import { mockPrisma } from '../setup';

type ExpoProto = {
  sendPushNotificationsAsync: (m: unknown[]) => Promise<unknown[]>;
};
const ExpoProto = (Expo as unknown as { prototype: ExpoProto }).prototype;

const VALID_TOKEN = 'ExponentPushToken[abc123]';
const VALID_TOKEN_2 = 'ExponentPushToken[def456]';
const INVALID_TOKEN = 'not-a-real-token';

describe('NotificationService', () => {
  describe('registerToken', () => {
    it('rejects an invalid Expo push token without touching the DB', async () => {
      await expect(
        NotificationService.registerToken('user-1', INVALID_TOKEN, 'ios')
      ).rejects.toThrow('Invalid Expo push token');
      expect(mockPrisma.pushToken.upsert).not.toHaveBeenCalled();
    });

    it('upserts a valid token keyed by token string with platform + userId', async () => {
      (mockPrisma.pushToken.upsert as jest.Mock).mockResolvedValue({
        id: 'pt-1',
        userId: 'user-1',
        token: VALID_TOKEN,
        platform: 'ios',
      });

      const result = await NotificationService.registerToken('user-1', VALID_TOKEN, 'ios');

      expect(mockPrisma.pushToken.upsert).toHaveBeenCalledWith({
        where: { token: VALID_TOKEN },
        create: { userId: 'user-1', token: VALID_TOKEN, platform: 'ios' },
        update: { userId: 'user-1', platform: 'ios' },
      });
      expect(result).toEqual(
        expect.objectContaining({ token: VALID_TOKEN, platform: 'ios' })
      );
    });
  });

  describe('removeToken', () => {
    it('deletes matching tokens via deleteMany', async () => {
      (mockPrisma.pushToken.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await NotificationService.removeToken(VALID_TOKEN);

      expect(mockPrisma.pushToken.deleteMany).toHaveBeenCalledWith({
        where: { token: VALID_TOKEN },
      });
      expect(result).toEqual({ count: 1 });
    });
  });

  describe('sendToUsers', () => {
    it('returns [] and skips Expo calls when no tokens exist for the given users', async () => {
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([]);

      const result = await NotificationService.sendToUsers(['user-1', 'user-2'], {
        title: 'Hi',
        body: 'Hello',
      });

      expect(result).toEqual([]);
      expect(mockPrisma.pushToken.findMany).toHaveBeenCalledWith({
        where: { userId: { in: ['user-1', 'user-2'] } },
        select: { token: true },
      });
    });

    it('builds one Expo message per token and returns a ticket per message', async () => {
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
        { token: VALID_TOKEN },
        { token: VALID_TOKEN_2 },
      ]);

      const tickets = await NotificationService.sendToUsers(['user-1'], {
        title: 'Game starting',
        body: 'Tip-off in 10 minutes',
        data: { gameId: 'g-1' },
      });

      // Mock's sendPushNotificationsAsync returns one ticket per message.
      expect(tickets).toHaveLength(2);
      expect(tickets.every(t => 'status' in t && t.status === 'ok')).toBe(true);
    });

    it('defaults data to an empty object and uses sound "default" in the Expo payload', async () => {
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
        { token: VALID_TOKEN },
      ]);

      const original = ExpoProto.sendPushNotificationsAsync;
      const captured: unknown[][] = [];
      ExpoProto.sendPushNotificationsAsync = async function (
        messages: unknown[]
      ): Promise<unknown[]> {
        captured.push(messages);
        return messages.map(() => ({ status: 'ok', id: 'r-1' }));
      };

      try {
        await NotificationService.sendToUsers(['user-1'], { title: 't', body: 'b' });
      } finally {
        ExpoProto.sendPushNotificationsAsync = original;
      }

      expect(captured).toHaveLength(1);
      const sentMessages = captured[0] as Array<{
        to: string;
        title: string;
        body: string;
        data: Record<string, unknown>;
        sound: string;
      }>;
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        to: VALID_TOKEN,
        title: 't',
        body: 'b',
        data: {},
        sound: 'default',
      });
    });

    it('swallows Expo errors per chunk and continues (logs but does not throw)', async () => {
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
        { token: VALID_TOKEN },
      ]);

      const original = ExpoProto.sendPushNotificationsAsync;
      let callCount = 0;
      ExpoProto.sendPushNotificationsAsync = async function (): Promise<unknown[]> {
        callCount += 1;
        throw new Error('Expo down');
      };

      let result: unknown[];
      try {
        result = await NotificationService.sendToUsers(['user-1'], {
          title: 't',
          body: 'b',
        });
      } finally {
        ExpoProto.sendPushNotificationsAsync = original;
      }

      expect(result).toEqual([]);
      expect(callCount).toBe(1);
    });
  });

  describe('sendToTeam', () => {
    it('returns [] when the team has no members and no staff', async () => {
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

      const result = await NotificationService.sendToTeam('team-1', {
        title: 't',
        body: 'b',
      });

      expect(result).toEqual([]);
      expect(mockPrisma.pushToken.findMany).not.toHaveBeenCalled();
    });

    it('unions member playerIds and staff userIds, then fans out to sendToUsers', async () => {
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { playerId: 'player-1' },
        { playerId: 'player-2' },
      ]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { userId: 'coach-1' },
        // Duplicate with member — Set should dedupe.
        { userId: 'player-1' },
      ]);
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
        { token: VALID_TOKEN },
      ]);

      await NotificationService.sendToTeam('team-1', { title: 't', body: 'b' });

      const findManyCall = (mockPrisma.pushToken.findMany as jest.Mock).mock.calls[0][0];
      const userIds = findManyCall.where.userId.in as string[];
      expect(userIds).toHaveLength(3);
      expect(new Set(userIds)).toEqual(new Set(['player-1', 'player-2', 'coach-1']));
    });

    it('excludes the given userId from the audience', async () => {
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { playerId: 'player-1' },
        { playerId: 'player-2' },
      ]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { userId: 'coach-1' },
      ]);
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
        { token: VALID_TOKEN },
      ]);

      await NotificationService.sendToTeam(
        'team-1',
        { title: 't', body: 'b' },
        'player-1'
      );

      const findManyCall = (mockPrisma.pushToken.findMany as jest.Mock).mock.calls[0][0];
      const userIds = findManyCall.where.userId.in as string[];
      expect(userIds).not.toContain('player-1');
      expect(new Set(userIds)).toEqual(new Set(['player-2', 'coach-1']));
    });

    it('returns [] when excludeUserId drains the only audience member', async () => {
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { playerId: 'only-user' },
      ]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

      const result = await NotificationService.sendToTeam(
        'team-1',
        { title: 't', body: 'b' },
        'only-user'
      );

      expect(result).toEqual([]);
      expect(mockPrisma.pushToken.findMany).not.toHaveBeenCalled();
    });
  });
});
