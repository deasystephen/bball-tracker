/**
 * Unit tests for the Socket.io rate limiters (audit #16).
 *
 * In-memory path (the suites run without Redis) — no Socket.io server.
 * Redis fallback: rate-limit-fallback.test.ts; shared counters against a
 * real Redis: tests/redis/socket-redis-adapter.redis.test.ts. The integration test verifies
 * the happy path still connects with the limiter middleware in place.
 */

import type { Socket } from 'socket.io';
import {
  HANDSHAKE_WINDOW_MS,
  JOIN_WINDOW_MS,
  MAX_CONCURRENT_PER_IP,
  MAX_HANDSHAKES_PER_WINDOW,
  MAX_JOINS_PER_WINDOW,
  checkHandshakeAllowed,
  RATE_LIMITED_MESSAGE,
  checkJoinAllowed,
  handshakeKey,
  handshakeRateLimit,
  hasConcurrentCapacity,
  registerConnection,
  releaseConnection,
  resetSocketRateLimits,
  socketClientIp,
} from '../../src/websocket/rate-limit';

function fakeSocket(headers: Record<string, string | string[]>, address = '10.0.0.1'): Socket {
  return { handshake: { headers, address } } as unknown as Socket;
}

describe('websocket/rate-limit', () => {
  beforeEach(() => {
    resetSocketRateLimits();
  });

  describe('socketClientIp', () => {
    it('takes the rightmost x-forwarded-for entry (the hop the ALB appended)', () => {
      const socket = fakeSocket({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
      expect(socketClientIp(socket)).toBe('203.0.113.9');
    });

    it('handles a single-entry x-forwarded-for', () => {
      const socket = fakeSocket({ 'x-forwarded-for': '203.0.113.9' });
      expect(socketClientIp(socket)).toBe('203.0.113.9');
    });

    it('falls back to the peer address without the header (local dev)', () => {
      const socket = fakeSocket({}, '127.0.0.1');
      expect(socketClientIp(socket)).toBe('127.0.0.1');
    });
  });

  describe('checkHandshakeAllowed', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('allows up to the per-window budget and rejects the attempt after it', async () => {
      for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
        expect(await checkHandshakeAllowed('203.0.113.9')).toBe(true);
      }
      expect(await checkHandshakeAllowed('203.0.113.9')).toBe(false);
    });

    it('tracks IPs independently', async () => {
      for (let i = 0; i <= MAX_HANDSHAKES_PER_WINDOW; i++) {
        await checkHandshakeAllowed('203.0.113.9');
      }
      expect(await checkHandshakeAllowed('203.0.113.9')).toBe(false);
      expect(await checkHandshakeAllowed('198.51.100.7')).toBe(true);
    });

    it('keys IPv6 by its /56 like the HTTP limiters, so walking the prefix shares one window', async () => {
      expect(handshakeKey('2001:db8:1:ab::1')).toBe(handshakeKey('2001:db8:1:ff:ffff::2'));
      expect(handshakeKey('2001:db8:1:ab::1')).not.toBe(handshakeKey('2001:db8:2::1'));
      expect(handshakeKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
      expect(handshakeKey('203.0.113.9')).toBe('203.0.113.9');

      for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
        await checkHandshakeAllowed(`2001:db8:1:ab::${(i + 1).toString(16)}`);
      }
      expect(await checkHandshakeAllowed('2001:db8:1:cd::1')).toBe(false);
      expect(await checkHandshakeAllowed('2001:db8:9::1')).toBe(true);
    });

    it('resets once the window has elapsed', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      resetSocketRateLimits();
      for (let i = 0; i <= MAX_HANDSHAKES_PER_WINDOW; i++) {
        await checkHandshakeAllowed('203.0.113.9');
      }
      expect(await checkHandshakeAllowed('203.0.113.9')).toBe(false);
      jest.setSystemTime(1_000_000 + HANDSHAKE_WINDOW_MS);
      expect(await checkHandshakeAllowed('203.0.113.9')).toBe(true);
    });
  });

  describe('handshakeRateLimit middleware', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    it('calls next once, with no error, within the budget', async () => {
      const next = jest.fn();
      handshakeRateLimit(fakeSocket({ 'x-forwarded-for': '203.0.113.20' }), next);
      await flush();
      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('calls next once with the rate-limited error over the budget', async () => {
      const socket = fakeSocket({ 'x-forwarded-for': '203.0.113.21' });
      for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
        await checkHandshakeAllowed('203.0.113.21');
      }
      const next = jest.fn();
      handshakeRateLimit(socket, next);
      await flush();
      expect(next).toHaveBeenCalledTimes(1);
      expect((next.mock.calls[0] as [Error])[0].message).toBe(RATE_LIMITED_MESSAGE);
    });

    it('never calls next a second time when downstream middleware throws', async () => {
      const next = jest.fn(() => {
        throw new Error('downstream exploded');
      });
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        handshakeRateLimit(fakeSocket({ 'x-forwarded-for': '203.0.113.22' }), next);
        await flush();
        await flush();
        expect(next).toHaveBeenCalledTimes(1);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  describe('concurrent connection cap', () => {
    it('reports capacity until the cap and none at it', () => {
      for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) {
        expect(hasConcurrentCapacity('203.0.113.9')).toBe(true);
        registerConnection('203.0.113.9');
      }
      expect(hasConcurrentCapacity('203.0.113.9')).toBe(false);
      expect(hasConcurrentCapacity('198.51.100.7')).toBe(true);
    });

    it('frees capacity when a connection is released', () => {
      for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) {
        registerConnection('203.0.113.9');
      }
      expect(hasConcurrentCapacity('203.0.113.9')).toBe(false);
      releaseConnection('203.0.113.9');
      expect(hasConcurrentCapacity('203.0.113.9')).toBe(true);
    });

    it('never goes negative on an unmatched release', () => {
      releaseConnection('203.0.113.9');
      registerConnection('203.0.113.9');
      releaseConnection('203.0.113.9');
      expect(hasConcurrentCapacity('203.0.113.9')).toBe(true);
    });
  });

  describe('checkJoinAllowed', () => {
    it('allows up to the per-window budget per socket and rejects after it', () => {
      const socket = {};
      const now = 1_000_000;
      for (let i = 0; i < MAX_JOINS_PER_WINDOW; i++) {
        expect(checkJoinAllowed(socket, now)).toBe(true);
      }
      expect(checkJoinAllowed(socket, now)).toBe(false);
    });

    it('tracks sockets independently', () => {
      const a = {};
      const b = {};
      const now = 1_000_000;
      for (let i = 0; i <= MAX_JOINS_PER_WINDOW; i++) {
        checkJoinAllowed(a, now);
      }
      expect(checkJoinAllowed(a, now)).toBe(false);
      expect(checkJoinAllowed(b, now)).toBe(true);
    });

    it('resets once the window has elapsed', () => {
      const socket = {};
      const now = 1_000_000;
      for (let i = 0; i <= MAX_JOINS_PER_WINDOW; i++) {
        checkJoinAllowed(socket, now);
      }
      expect(checkJoinAllowed(socket, now)).toBe(false);
      expect(checkJoinAllowed(socket, now + JOIN_WINDOW_MS)).toBe(true);
    });
  });
});
