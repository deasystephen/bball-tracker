/**
 * Mid-session re-verification of a socket's handshake token (#49).
 *
 * Drives `scheduleSocketReauth` / `reverifySocket` with fake timers and a
 * lightweight fake socket. The transport path (event delivered, transport
 * closed, client reconnects with a fresh token) is covered in
 * `game-events.integration.test.ts`.
 */

import {
  REAUTH_GRACE_MS,
  REAUTH_MAX_INTERVAL_MS,
  REAUTH_REQUIRED_EVENT,
  REAUTH_RETRY_MS,
  clearSocketReauth,
  pendingReauthCount,
  reauthDelayMs,
  reverifySocket,
  scheduleSocketReauth,
  type GameSocket,
} from '../../src/websocket/game-events';
import { WorkOSService, JWT_CLOCK_TOLERANCE_SECONDS } from '../../src/services/workos-service';
import { ServiceUnavailableError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { mockPrisma } from '../setup';
import { devToken } from '../support/auth-fixtures';

const USER = { id: 'user-1', email: null, name: 'Coach', role: 'COACH' };
const MINUTE = 60_000;

interface FakeSocket {
  id: string;
  connected: boolean;
  handshake: { auth: { token?: string }; headers: Record<string, string> };
  data: { user: typeof USER; tokenExpiresAt: number | null };
  emit: jest.Mock;
  conn: { close: jest.Mock };
}

let socketSeq = 0;

function makeSocket(token: string, tokenExpiresAt: number | null): FakeSocket {
  socketSeq += 1;
  const socket: FakeSocket = {
    id: `sock-reauth-${socketSeq}`,
    connected: true,
    handshake: { auth: { token }, headers: {} },
    data: { user: { ...USER }, tokenExpiresAt },
    emit: jest.fn(),
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
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('socket re-auth (#49)', () => {
  const originalEnv = process.env.NODE_ENV;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('reauthDelayMs', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');

    it('waits until expiry plus a grace longer than the verifier clock tolerance', () => {
      expect(REAUTH_GRACE_MS).toBeGreaterThan(JWT_CLOCK_TOLERANCE_SECONDS * 1000);
      expect(reauthDelayMs(now + 5 * MINUTE, now)).toBe(5 * MINUTE + REAUTH_GRACE_MS);
    });

    it('checks an already-expired token after the grace only', () => {
      expect(reauthDelayMs(now - MINUTE, now)).toBe(REAUTH_GRACE_MS);
    });

    it('falls back to the bounded interval when the token has no expiry', () => {
      expect(reauthDelayMs(null, now)).toBe(REAUTH_MAX_INTERVAL_MS);
      expect(reauthDelayMs(Number.NaN, now)).toBe(REAUTH_MAX_INTERVAL_MS);
    });

    it('never waits longer than the bounded interval', () => {
      expect(reauthDelayMs(now + 24 * 60 * MINUTE, now)).toBe(REAUTH_MAX_INTERVAL_MS);
    });
  });

  describe('scheduler', () => {
    it('does not re-verify a token before it expires, then cuts it off with reauth_required', async () => {
      process.env.NODE_ENV = 'development';
      const exp = Date.now() + 5 * MINUTE;
      const socket = makeSocket(devToken({ userId: USER.id, exp }), exp);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(USER);

      scheduleSocketReauth(asGameSocket(socket));
      expect(pendingReauthCount()).toBe(1);

      // Up to one tick before exp + grace: no check, still connected.
      await jest.advanceTimersByTimeAsync(5 * MINUTE + REAUTH_GRACE_MS - 1);
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
      expect(infoSpy).toHaveBeenCalledWith('Socket reauth required', {
        socketId: socket.id,
        userId: USER.id,
      });
      // Ids only: the token never reaches a log line.
      const token = socket.handshake.auth.token as string;
      expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(token);
      expect(pendingReauthCount()).toBe(0);
    });

    it('keeps a socket whose token is still valid and schedules the next check', async () => {
      const exp = Date.now() + 2 * 60 * MINUTE;
      const verify = jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockResolvedValue({ id: 'workos-1', expiresAt: exp / 1000 });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...USER, name: 'Renamed' });
      const socket = makeSocket('workos.jwt.token', exp);

      scheduleSocketReauth(asGameSocket(socket));
      await jest.advanceTimersByTimeAsync(REAUTH_MAX_INTERVAL_MS);
      await flush();

      expect(verify).toHaveBeenCalledWith('workos.jwt.token');
      expect(socket.conn.close).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.data.user.name).toBe('Renamed');
      expect(pendingReauthCount()).toBe(1);

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

    it('cuts off a deleted account (the tombstone-filtered lookup finds no row)', async () => {
      jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockResolvedValue({ id: 'workos-1', expiresAt: (Date.now() + 60 * MINUTE) / 1000 });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      const socket = makeSocket('workos.jwt.token', Date.now() + 60 * MINUTE);

      expect(await reverifySocket(asGameSocket(socket))).toBe('reauth_required');
      expect(socket.conn.close).toHaveBeenCalledTimes(1);
    });

    it('clears the timer when the socket disconnects early (no leak, no check)', async () => {
      const verify = jest.spyOn(WorkOSService, 'verifyToken');
      const socket = makeSocket('workos.jwt.token', Date.now() + MINUTE);

      scheduleSocketReauth(asGameSocket(socket));
      expect(pendingReauthCount()).toBe(1);

      clearSocketReauth(socket.id);
      clearSocketReauth(socket.id); // idempotent
      expect(pendingReauthCount()).toBe(0);

      await jest.advanceTimersByTimeAsync(REAUTH_MAX_INTERVAL_MS * 2);
      expect(verify).not.toHaveBeenCalled();
    });

    it('replaces, never stacks, a socket timer when rescheduled', () => {
      const socket = makeSocket('workos.jwt.token', Date.now() + MINUTE);
      scheduleSocketReauth(asGameSocket(socket));
      scheduleSocketReauth(asGameSocket(socket));
      expect(pendingReauthCount()).toBe(1);
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
      expect(pendingReauthCount()).toBe(0);
    });

    it('retries later on a verifier outage while the token has not expired', async () => {
      jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockRejectedValue(new ServiceUnavailableError('JWKS unreachable'));
      const socket = makeSocket('workos.jwt.token', Date.now() + 10 * MINUTE);

      expect(await reverifySocket(asGameSocket(socket))).toBe('retry');
      expect(socket.conn.close).not.toHaveBeenCalled();
      expect(pendingReauthCount()).toBe(1);

      // The retry is due after REAUTH_RETRY_MS.
      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(null);
      await jest.advanceTimersByTimeAsync(REAUTH_RETRY_MS);
      await flush();
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

    it('requires re-auth if the token now resolves to a different user', async () => {
      jest
        .spyOn(WorkOSService, 'verifyToken')
        .mockResolvedValue({ id: 'workos-2', expiresAt: (Date.now() + 60 * MINUTE) / 1000 });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...USER, id: 'someone-else' });
      const socket = makeSocket('workos.jwt.token', null);

      expect(await reverifySocket(asGameSocket(socket))).toBe('reauth_required');
    });
  });
});
