/**
 * Mid-session re-verification of a socket's token (#49).
 *
 * Drives `handleRefreshAuth` (in-band refresh), `scheduleSocketReauth` /
 * `reverifySocket` (the fallback timer) and `pruneGameRooms` (audit #72) with
 * fake timers and a lightweight fake socket. The transport path is covered in
 * `game-events.integration.test.ts`.
 */

jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));
jest.mock('../../src/utils/permissions', () => ({
  ...jest.requireActual('../../src/utils/permissions'),
  canAccessTeam: jest.fn(),
}));

import {
  GAME_ROOM_PREFIX,
  REAUTH_GRACE_MS,
  REAUTH_JITTER_MAX_MS,
  REAUTH_MAX_INTERVAL_MS,
  REAUTH_REQUIRED_EVENT,
  REAUTH_RETRY_MS,
  clearSocketReauth,
  handleRefreshAuth,
  hasPendingReauth,
  pendingReauthCount,
  pruneGameRooms,
  reauthDelayMs,
  reverifySocket,
  scheduleSocketReauth,
  type GameSocket,
} from '../../src/websocket/game-events';
import { MAX_REFRESH_AUTHS_PER_WINDOW } from '../../src/websocket/rate-limit';
import { WorkOSService, JWT_CLOCK_TOLERANCE_SECONDS } from '../../src/services/workos-service';
import { ServiceUnavailableError, UnauthorizedError } from '../../src/utils/errors';
import { captureException } from '../../src/utils/sentry';
import { canAccessTeam } from '../../src/utils/permissions';
import { logger } from '../../src/utils/logger';
import { mockPrisma } from '../setup';
import { devToken } from '../support/auth-fixtures';

const USER = { id: 'user-1', email: null, name: 'Coach', role: 'COACH' };
const MINUTE = 60_000;
const mockCapture = captureException as jest.Mock;
const mockCanAccessTeam = canAccessTeam as jest.Mock;

interface FakeSocket {
  id: string;
  connected: boolean;
  handshake: { auth: { token?: string }; headers: Record<string, string> };
  data: {
    user: typeof USER;
    tokenExpiresAt: number | null;
    authToken?: string;
    reauthJitterMs?: number;
  };
  rooms: Set<string>;
  emit: jest.Mock;
  leave: jest.Mock;
  conn: { close: jest.Mock };
}

let socketSeq = 0;

function makeSocket(token: string, tokenExpiresAt: number | null, jitterMs = 0): FakeSocket {
  socketSeq += 1;
  const id = `sock-reauth-${socketSeq}`;
  const socket: FakeSocket = {
    id,
    connected: true,
    handshake: { auth: { token }, headers: {} },
    data: { user: { ...USER }, tokenExpiresAt, authToken: token, reauthJitterMs: jitterMs },
    rooms: new Set([id]),
    emit: jest.fn(),
    leave: jest.fn((room: string) => {
      socket.rooms.delete(room);
      return Promise.resolve();
    }),
    conn: {
      close: jest.fn(() => {
        socket.connected = false;
      }),
    },
  };
  return socket;
}

const asGameSocket = (s: FakeSocket): GameSocket => s as unknown as GameSocket;

/** Let the timer callback's awaited verification settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const workosSession = (expiresAtMs: number): jest.SpyInstance =>
  jest.spyOn(WorkOSService, 'verifyToken').mockResolvedValue({ id: 'workos-1', expiresAt: expiresAtMs / 1000 });

describe('socket re-auth (#49)', () => {
  const originalEnv = process.env.NODE_ENV;
  let infoSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    mockCanAccessTeam.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const reauthLogs = (spy: jest.SpyInstance): unknown[] =>
    spy.mock.calls.filter((c) => c[0] === 'Socket reauth required').map((c) => c[1]);

  describe('reauthDelayMs', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');

    it('waits until expiry plus a grace longer than the verifier clock tolerance', () => {
      expect(REAUTH_GRACE_MS).toBeGreaterThan(JWT_CLOCK_TOLERANCE_SECONDS * 1000);
      expect(reauthDelayMs(now + 5 * MINUTE, now)).toBe(5 * MINUTE + REAUTH_GRACE_MS);
    });

    it('adds the per-socket jitter to the grace', () => {
      expect(reauthDelayMs(now + 5 * MINUTE, now, 7_000)).toBe(5 * MINUTE + REAUTH_GRACE_MS + 7_000);
    });

    it('checks an already-expired token after the grace only', () => {
      expect(reauthDelayMs(now - MINUTE, now)).toBe(REAUTH_GRACE_MS);
    });

    it('falls back to the bounded interval when the token has no expiry', () => {
      expect(reauthDelayMs(null, now)).toBe(REAUTH_MAX_INTERVAL_MS);
      expect(reauthDelayMs(Number.NaN, now)).toBe(REAUTH_MAX_INTERVAL_MS);
    });

    it('never waits longer than the bounded interval', () => {
      expect(reauthDelayMs(now + 24 * 60 * MINUTE, now, REAUTH_JITTER_MAX_MS)).toBe(REAUTH_MAX_INTERVAL_MS);
    });
  });

  describe('scheduler (fallback timer)', () => {
    it('gives each socket a fixed jitter in [0, REAUTH_JITTER_MAX_MS)', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const socket = makeSocket('workos.jwt.token', Date.now() + MINUTE);
      delete socket.data.reauthJitterMs;

      scheduleSocketReauth(asGameSocket(socket));
      expect(socket.data.reauthJitterMs).toBe(REAUTH_JITTER_MAX_MS / 2);
      (Math.random as jest.Mock).mockReturnValue(0.9);
      scheduleSocketReauth(asGameSocket(socket));
      expect(socket.data.reauthJitterMs).toBe(REAUTH_JITTER_MAX_MS / 2);
      clearSocketReauth(socket.id);
    });

    it('does not re-verify before exp + grace + jitter, then cuts an expired token off at debug level', async () => {
      process.env.NODE_ENV = 'development';
      const exp = Date.now() + 5 * MINUTE;
      const socket = makeSocket(devToken({ userId: USER.id, exp }), exp, 3_000);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(USER);

      scheduleSocketReauth(asGameSocket(socket));
      expect(hasPendingReauth(socket.id)).toBe(true);

      await jest.advanceTimersByTimeAsync(5 * MINUTE + REAUTH_GRACE_MS + 3_000 - 1);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(socket.conn.close).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await flush();

      expect(socket.emit).toHaveBeenCalledWith(REAUTH_REQUIRED_EVENT, {});
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
      // The event goes out before the transport is closed.
      expect(socket.emit.mock.invocationCallOrder[0]).toBeLessThan(
        socket.conn.close.mock.invocationCallOrder[0]
      );
      // The expected expiry cycle logs at debug, never info.
      expect(reauthLogs(debugSpy)).toEqual([{ socketId: socket.id, userId: USER.id, reason: 'expired' }]);
      expect(reauthLogs(infoSpy)).toEqual([]);
      // Ids only: the token never reaches a log line.
      const token = socket.handshake.auth.token as string;
      expect(JSON.stringify([...infoSpy.mock.calls, ...debugSpy.mock.calls])).not.toContain(token);
      expect(hasPendingReauth(socket.id)).toBe(false);
    });

    it('keeps a socket whose token is still valid and schedules the next check', async () => {
      const exp = Date.now() + 2 * 60 * MINUTE;
      const verify = workosSession(exp);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...USER, name: 'Renamed' });
      const socket = makeSocket('workos.jwt.token', exp);

      scheduleSocketReauth(asGameSocket(socket));
      await jest.advanceTimersByTimeAsync(REAUTH_MAX_INTERVAL_MS);
      await flush();

      expect(verify).toHaveBeenCalledWith('workos.jwt.token');
      expect(socket.conn.close).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.data.user.name).toBe('Renamed');
      expect(hasPendingReauth(socket.id)).toBe(true);
      expect(debugSpy).toHaveBeenCalledWith('Socket reauth check passed', { socketId: socket.id, userId: USER.id });

      clearSocketReauth(socket.id);
    });

    it('re-verifies a WorkOS token at expiry and disconnects when the verifier rejects it', async () => {
      const exp = Date.now() + MINUTE;
      const verify = jest.spyOn(WorkOSService, 'verifyToken').mockResolvedValue(null);
      const socket = makeSocket('workos.jwt.token', exp);

      scheduleSocketReauth(asGameSocket(socket));
      await jest.advanceTimersByTimeAsync(MINUTE + REAUTH_GRACE_MS);
      await flush();

      expect(verify).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith(REAUTH_REQUIRED_EVENT, {});
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
    });

    it('cuts off a deleted account with an unexpired token and logs it at info', async () => {
      workosSession(Date.now() + 60 * MINUTE);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      const socket = makeSocket('workos.jwt.token', Date.now() + 60 * MINUTE);

      expect(await reverifySocket(asGameSocket(socket))).toBe('reauth_required');
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
      expect(reauthLogs(infoSpy)).toEqual([{ socketId: socket.id, userId: USER.id, reason: 'rejected' }]);
    });

    it('clears the timer when the socket disconnects early (no leak, no check)', async () => {
      const verify = jest.spyOn(WorkOSService, 'verifyToken');
      const socket = makeSocket('workos.jwt.token', Date.now() + MINUTE);

      scheduleSocketReauth(asGameSocket(socket));
      expect(hasPendingReauth(socket.id)).toBe(true);

      clearSocketReauth(socket.id);
      clearSocketReauth(socket.id); // idempotent
      expect(hasPendingReauth(socket.id)).toBe(false);

      await jest.advanceTimersByTimeAsync(REAUTH_MAX_INTERVAL_MS * 2);
      expect(verify).not.toHaveBeenCalled();
    });

    it('replaces, never stacks, a socket timer when rescheduled', () => {
      const before = pendingReauthCount();
      const socket = makeSocket('workos.jwt.token', Date.now() + MINUTE);
      scheduleSocketReauth(asGameSocket(socket));
      scheduleSocketReauth(asGameSocket(socket));
      expect(pendingReauthCount()).toBe(before + 1);
      clearSocketReauth(socket.id);
    });
  });

  describe('reverifySocket edge cases', () => {
    it('skips a socket that has already disconnected', async () => {
      const verify = jest.spyOn(WorkOSService, 'verifyToken');
      const socket = makeSocket('workos.jwt.token', null);
      socket.connected = false;

      expect(await reverifySocket(asGameSocket(socket))).toBe('skipped');
      expect(verify).not.toHaveBeenCalled();
    });

    it('does not act on a socket that disconnected while the check was in flight', async () => {
      const socket = makeSocket('workos.jwt.token', null);
      jest.spyOn(WorkOSService, 'verifyToken').mockImplementation(async () => {
        socket.connected = false;
        return null;
      });

      expect(await reverifySocket(asGameSocket(socket))).toBe('skipped');
      expect(socket.emit).not.toHaveBeenCalled();
      expect(hasPendingReauth(socket.id)).toBe(false);
    });

    it('reports a verifier outage to Sentry and retries later while the token has not expired', async () => {
      jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockRejectedValue(new ServiceUnavailableError('JWKS unreachable'));
      const socket = makeSocket('workos.jwt.token', Date.now() + 10 * MINUTE);

      expect(await reverifySocket(asGameSocket(socket))).toBe('retry');
      expect(mockCapture).toHaveBeenCalledWith(expect.any(ServiceUnavailableError), {
        flow: 'socket-reauth',
        socketId: socket.id,
      });
      expect(socket.conn.close).not.toHaveBeenCalled();
      expect(hasPendingReauth(socket.id)).toBe(true);

      // The retry is due after REAUTH_RETRY_MS.
      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(null);
      await jest.advanceTimersByTimeAsync(REAUTH_RETRY_MS);
      await flush();
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
    });

    it('reports a database failover to Sentry too', async () => {
      workosSession(Date.now() + 10 * MINUTE);
      (mockPrisma.user.findUnique as jest.Mock).mockRejectedValue(new Error('connection terminated'));
      const socket = makeSocket('workos.jwt.token', Date.now() + 10 * MINUTE);

      expect(await reverifySocket(asGameSocket(socket))).toBe('retry');
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection terminated' }), {
        flow: 'socket-reauth',
        socketId: socket.id,
      });
      clearSocketReauth(socket.id);
    });

    it('treats a thrown 4xx AppError as a rejection, not an outage', async () => {
      jest.spyOn(WorkOSService, 'verifyToken').mockRejectedValue(new UnauthorizedError('Token revoked'));
      const socket = makeSocket('workos.jwt.token', Date.now() + 10 * MINUTE);

      expect(await reverifySocket(asGameSocket(socket))).toBe('reauth_required');
      expect(mockCapture).not.toHaveBeenCalled();
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
    });

    it('cuts off an expired token even when the verifier is down', async () => {
      jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockRejectedValue(new ServiceUnavailableError('JWKS unreachable'));
      const socket = makeSocket('workos.jwt.token', Date.now() - REAUTH_GRACE_MS);

      expect(await reverifySocket(asGameSocket(socket))).toBe('reauth_required');
      expect(socket.emit).toHaveBeenCalledWith(REAUTH_REQUIRED_EVENT, {});
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
    });

    it('requires re-auth, logged at info, if the token now resolves to a different user', async () => {
      workosSession(Date.now() + 60 * MINUTE);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...USER, id: 'someone-else' });
      const socket = makeSocket('workos.jwt.token', null);

      expect(await reverifySocket(asGameSocket(socket))).toBe('reauth_required');
      expect(reauthLogs(infoSpy)).toEqual([{ socketId: socket.id, userId: USER.id, reason: 'user_changed' }]);
    });
  });

  describe('room re-check (audit #72)', () => {
    it('leaves game rooms the user can no longer access when a valid token is re-checked', async () => {
      workosSession(Date.now() + 60 * MINUTE);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(USER);
      (mockPrisma.game.findUnique as jest.Mock).mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve(args.where.id === 'gone' ? null : { teamId: `team-${args.where.id}` })
      );
      mockCanAccessTeam.mockImplementation((_userId: string, teamId: string) =>
        Promise.resolve(teamId === 'team-kept')
      );
      const socket = makeSocket('workos.jwt.token', Date.now() + 60 * MINUTE);
      ['kept', 'removed', 'gone'].forEach((g) => socket.rooms.add(`${GAME_ROOM_PREFIX}${g}`));

      expect(await reverifySocket(asGameSocket(socket))).toBe('kept');

      expect([...socket.rooms]).toEqual([socket.id, `${GAME_ROOM_PREFIX}kept`]);
      expect(mockCanAccessTeam).toHaveBeenCalledWith(USER.id, 'team-removed');
      expect(infoSpy).toHaveBeenCalledWith('Socket evicted from game room', {
        socketId: socket.id,
        userId: USER.id,
        gameId: 'removed',
      });
      expect(socket.conn.close).not.toHaveBeenCalled();
      clearSocketReauth(socket.id);
    });

    it('keeps the rooms and reports to Sentry when the access lookup fails', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));
      const socket = makeSocket('workos.jwt.token', null);
      socket.rooms.add(`${GAME_ROOM_PREFIX}g1`);

      expect(await pruneGameRooms(asGameSocket(socket))).toEqual([]);
      expect(socket.rooms.has(`${GAME_ROOM_PREFIX}g1`)).toBe(true);
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), {
        flow: 'socket-reauth',
        socketId: socket.id,
      });
    });
  });

  describe('handleRefreshAuth (in-band refresh)', () => {
    it('moves the socket onto a fresh token for the same user without disconnecting', async () => {
      const oldExp = Date.now() + MINUTE;
      const newExp = Date.now() + 10 * MINUTE;
      const socket = makeSocket('old.jwt.token', oldExp);
      socket.rooms.add(`${GAME_ROOM_PREFIX}g1`);
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({ teamId: 'team-1' });
      scheduleSocketReauth(asGameSocket(socket));

      const verify = workosSession(newExp);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(USER);

      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'new.jwt.token' })).toEqual({ ok: true });
      expect(verify).toHaveBeenCalledWith('new.jwt.token');
      expect(socket.data.authToken).toBe('new.jwt.token');
      expect(socket.data.tokenExpiresAt).toBe(newExp);
      expect(mockCanAccessTeam).toHaveBeenCalledWith(USER.id, 'team-1');
      expect(socket.emit).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith('Socket auth refreshed', { socketId: socket.id, userId: USER.id });
      expect(JSON.stringify([...infoSpy.mock.calls, ...debugSpy.mock.calls])).not.toContain('new.jwt.token');

      // The old expiry no longer cuts the socket off.
      verify.mockClear();
      await jest.advanceTimersByTimeAsync(MINUTE + REAUTH_GRACE_MS);
      await flush();
      expect(verify).not.toHaveBeenCalled();
      expect(socket.conn.close).not.toHaveBeenCalled();

      // The next re-check, at the new expiry, verifies the new token.
      await jest.advanceTimersByTimeAsync(9 * MINUTE);
      await flush();
      expect(verify).toHaveBeenCalledWith('new.jwt.token');
      clearSocketReauth(socket.id);
    });

    it('evicts a removed user from a game room on refresh (audit #72)', async () => {
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);
      socket.rooms.add(`${GAME_ROOM_PREFIX}g1`);
      workosSession(Date.now() + 10 * MINUTE);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(USER);
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({ teamId: 'team-1' });
      mockCanAccessTeam.mockResolvedValue(false);

      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'new.jwt.token' })).toEqual({ ok: true });
      expect(socket.leave).toHaveBeenCalledWith(`${GAME_ROOM_PREFIX}g1`);
      clearSocketReauth(socket.id);
    });

    it('keeps the socket on its current token and timer when the new token is rejected', async () => {
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);
      scheduleSocketReauth(asGameSocket(socket));
      jest.spyOn(WorkOSService, 'verifyToken').mockResolvedValue(null);

      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'bad.jwt.token' })).toEqual({
        ok: false,
        code: 'unauthorized',
      });
      expect(socket.data.authToken).toBe('old.jwt.token');
      expect(socket.conn.close).not.toHaveBeenCalled();
      expect(hasPendingReauth(socket.id)).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith('Socket refresh-auth rejected', { socketId: socket.id, userId: USER.id });
      clearSocketReauth(socket.id);
    });

    it('ends the connection when the new token belongs to another user', async () => {
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);
      workosSession(Date.now() + 10 * MINUTE);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...USER, id: 'someone-else' });

      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'other.jwt.token' })).toEqual({
        ok: false,
        code: 'unauthorized',
      });
      expect(socket.emit).toHaveBeenCalledWith(REAUTH_REQUIRED_EVENT, {});
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
      expect(socket.data.user.id).toBe(USER.id);
    });

    it.each([undefined, null, {}, { token: '' }, { token: 42 }])('rejects a malformed payload %p', async (payload) => {
      const verify = jest.spyOn(WorkOSService, 'verifyToken');
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);
      expect(await handleRefreshAuth(asGameSocket(socket), payload)).toEqual({ ok: false, code: 'bad_request' });
      expect(verify).not.toHaveBeenCalled();
    });

    it('rate-limits refresh-auth per socket before any verification', async () => {
      const verify = jest.spyOn(WorkOSService, 'verifyToken').mockResolvedValue(null);
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);
      for (let i = 0; i < MAX_REFRESH_AUTHS_PER_WINDOW; i += 1) {
        await handleRefreshAuth(asGameSocket(socket), { token: 'x.y.z' });
      }
      verify.mockClear();
      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'x.y.z' })).toEqual({
        ok: false,
        code: 'rate_limited',
      });
      expect(verify).not.toHaveBeenCalled();
    });

    it('answers unavailable and reports an outage to Sentry, keeping the socket', async () => {
      jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockRejectedValue(new ServiceUnavailableError('JWKS unreachable'));
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);

      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'new.jwt.token' })).toEqual({
        ok: false,
        code: 'unavailable',
      });
      expect(mockCapture).toHaveBeenCalledWith(expect.any(ServiceUnavailableError), {
        flow: 'socket-refresh-auth',
        socketId: socket.id,
      });
      expect(socket.conn.close).not.toHaveBeenCalled();
    });

    it('answers unauthorized, without Sentry, for a thrown 4xx AppError', async () => {
      jest.spyOn(WorkOSService, 'verifyToken').mockRejectedValue(new UnauthorizedError('Token revoked'));
      const socket = makeSocket('old.jwt.token', Date.now() + MINUTE);

      expect(await handleRefreshAuth(asGameSocket(socket), { token: 'new.jwt.token' })).toEqual({
        ok: false,
        code: 'unauthorized',
      });
      expect(mockCapture).not.toHaveBeenCalled();
    });
  });
});
