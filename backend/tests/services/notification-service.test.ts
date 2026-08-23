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
import { NotificationService, PUSH_TOKEN_REBIND_AFTER_MS } from '../../src/services/notification-service';
import { mockPrisma } from '../setup';

type ExpoProto = {
  sendPushNotificationsAsync: (m: unknown[]) => Promise<unknown[]>;
  getPushNotificationReceiptsAsync: (ids: string[]) => Promise<Record<string, unknown>>;
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

    it('upserts a new token keyed by token string with platform + userId', async () => {
      (mockPrisma.pushToken.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.pushToken.upsert as jest.Mock).mockResolvedValue({
        id: 'pt-1',
        userId: 'user-1',
        token: VALID_TOKEN,
        platform: 'ios',
      });

      const result = await NotificationService.registerToken('user-1', VALID_TOKEN, 'ios');

      expect(mockPrisma.pushToken.findUnique).toHaveBeenCalledWith({ where: { token: VALID_TOKEN } });
      expect(mockPrisma.pushToken.upsert).toHaveBeenCalledWith({
        where: { token: VALID_TOKEN },
        create: { userId: 'user-1', token: VALID_TOKEN, platform: 'ios' },
        update: { userId: 'user-1', platform: 'ios' },
      });
      expect(result).toEqual(
        expect.objectContaining({ token: VALID_TOKEN, platform: 'ios' })
      );
    });

    describe('token already registered (role matrix B2.9)', () => {
      const existingRow = (userId: string, ageMs: number): {
        id: string;
        userId: string;
        token: string;
        platform: string;
        createdAt: Date;
        updatedAt: Date;
      } => ({
        id: 'pt-1',
        userId,
        token: VALID_TOKEN,
        platform: 'ios',
        createdAt: new Date(Date.now() - ageMs - 60_000),
        updatedAt: new Date(Date.now() - ageMs),
      });

      it('lets the same user re-register (refreshes platform)', async () => {
        (mockPrisma.pushToken.findUnique as jest.Mock).mockResolvedValue(existingRow('user-1', 0));
        (mockPrisma.pushToken.upsert as jest.Mock).mockResolvedValue(existingRow('user-1', 0));

        await NotificationService.registerToken('user-1', VALID_TOKEN, 'android');

        expect(mockPrisma.pushToken.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ where: { token: VALID_TOKEN }, update: { userId: 'user-1', platform: 'android' } })
        );
        expect(mockPrisma.pushToken.update).not.toHaveBeenCalled();
      });

      it('rejects rebinding a token freshly registered to a different user with 409', async () => {
        (mockPrisma.pushToken.findUnique as jest.Mock).mockResolvedValue(existingRow('victim', 5 * 60 * 1000));

        await expect(
          NotificationService.registerToken('attacker', VALID_TOKEN, 'ios')
        ).rejects.toMatchObject({ statusCode: 409, message: 'Push token is registered to another account' });
        expect(mockPrisma.pushToken.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.pushToken.update).not.toHaveBeenCalled();
      });

      it('still rejects at just under the 24h boundary', async () => {
        (mockPrisma.pushToken.findUnique as jest.Mock).mockResolvedValue(
          existingRow('victim', PUSH_TOKEN_REBIND_AFTER_MS - 1000)
        );

        await expect(
          NotificationService.registerToken('attacker', VALID_TOKEN, 'ios')
        ).rejects.toMatchObject({ statusCode: 409 });
      });

      it('rebinds a stale (> 24h) token left by another user to the caller', async () => {
        (mockPrisma.pushToken.findUnique as jest.Mock).mockResolvedValue(
          existingRow('previous-owner', PUSH_TOKEN_REBIND_AFTER_MS + 1000)
        );
        (mockPrisma.pushToken.update as jest.Mock).mockResolvedValue({
          ...existingRow('user-2', 0),
        });

        const result = await NotificationService.registerToken('user-2', VALID_TOKEN, 'ios');

        expect(mockPrisma.pushToken.update).toHaveBeenCalledWith({
          where: { token: VALID_TOKEN },
          data: { userId: 'user-2', platform: 'ios' },
        });
        expect(mockPrisma.pushToken.upsert).not.toHaveBeenCalled();
        expect(result.userId).toBe('user-2');
      });
    });
  });

  describe('removeToken', () => {
    it('deletes the token only when it belongs to the caller (audit #47)', async () => {
      (mockPrisma.pushToken.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await NotificationService.removeToken('user-1', VALID_TOKEN);

      expect(mockPrisma.pushToken.deleteMany).toHaveBeenCalledWith({
        where: { token: VALID_TOKEN, userId: 'user-1' },
      });
      expect(result).toEqual({ count: 1 });
    });

    it('never issues an unscoped delete by token value', async () => {
      (mockPrisma.pushToken.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

      await NotificationService.removeToken('user-2', VALID_TOKEN);

      const where = (mockPrisma.pushToken.deleteMany as jest.Mock).mock.calls[0][0].where;
      expect(where.userId).toBe('user-2');
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

describe('dead push token pruning (audit #60)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (mockPrisma.pushToken.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('deletes a token whose send ticket says DeviceNotRegistered', async () => {
    (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
      { token: VALID_TOKEN },
      { token: VALID_TOKEN_2 },
    ]);
    jest.spyOn(ExpoProto, 'sendPushNotificationsAsync').mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok', id: 'ticket-2' },
    ]);

    await NotificationService.sendToUsers(['user-1'], { title: 't', body: 'b' });

    expect(mockPrisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: [VALID_TOKEN] } },
    });
  });

  it('does not delete tokens for transient ticket errors', async () => {
    (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([{ token: VALID_TOKEN }]);
    jest.spyOn(ExpoProto, 'sendPushNotificationsAsync').mockResolvedValue([
      { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
    ]);

    await NotificationService.sendToUsers(['user-1'], { title: 't', body: 'b' });

    expect(mockPrisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });

  it('schedules a receipt check ~15 minutes after a successful send and prunes DeviceNotRegistered receipts', async () => {
    (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([
      { token: VALID_TOKEN },
      { token: VALID_TOKEN_2 },
    ]);
    jest.spyOn(ExpoProto, 'sendPushNotificationsAsync').mockResolvedValue([
      { status: 'ok', id: 'ticket-1' },
      { status: 'ok', id: 'ticket-2' },
    ]);
    const receipts = jest.spyOn(ExpoProto, 'getPushNotificationReceiptsAsync').mockResolvedValue({
      'ticket-1': { status: 'ok' },
      'ticket-2': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    });

    await NotificationService.sendToUsers(['user-1'], { title: 't', body: 'b' });
    expect(receipts).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(receipts).toHaveBeenCalledWith(['ticket-1', 'ticket-2']);
    expect(mockPrisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: [VALID_TOKEN_2] } },
    });
  });

  it('checkReceipts returns the number of pruned tokens and survives Expo errors', async () => {
    jest.spyOn(ExpoProto, 'getPushNotificationReceiptsAsync').mockRejectedValue(new Error('expo down'));

    const pruned = await NotificationService.checkReceipts(new Map([['ticket-1', VALID_TOKEN]]));

    expect(pruned).toBe(0);
    expect(mockPrisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });

  it('still returns tickets when pruning dead tokens fails (logged, not thrown)', async () => {
    (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([{ token: VALID_TOKEN }]);
    (mockPrisma.pushToken.deleteMany as jest.Mock).mockRejectedValue(new Error('db down'));
    jest.spyOn(ExpoProto, 'sendPushNotificationsAsync').mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);

    const tickets = await NotificationService.sendToUsers(['user-1'], { title: 't', body: 'b' });

    expect(tickets).toHaveLength(1);
    expect(mockPrisma.pushToken.deleteMany).toHaveBeenCalled();
  });

  it('swallows a failing scheduled receipt check', async () => {
    (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([{ token: VALID_TOKEN }]);
    jest.spyOn(ExpoProto, 'sendPushNotificationsAsync').mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
    const check = jest.spyOn(NotificationService, 'checkReceipts').mockRejectedValue(new Error('boom'));

    await NotificationService.sendToUsers(['user-1'], { title: 't', body: 'b' });
    await expect(jest.advanceTimersByTimeAsync(15 * 60 * 1000)).resolves.toBeUndefined();

    expect(check).toHaveBeenCalledWith(new Map([['ticket-1', VALID_TOKEN]]));
  });

  it('pruneDeadTokens is a no-op for an empty list', async () => {
    await expect(NotificationService.pruneDeadTokens([])).resolves.toBe(0);
    expect(mockPrisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });
});

});
