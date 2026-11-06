/**
 * Unit tests for the Socket.io rate limiters (audit #16).
 *
 * In-memory path (the suites run without Redis) — no Socket.io server.
 * Redis fallback: rate-limit-fallback.test.ts; shared counters against a
 * real Redis: tests/integration/socket-redis-adapter.redis.test.ts. The integration test verifies
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
  checkJoinAllowed,
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
    it('allows up to the per-window budget and rejects the attempt after it', async () => {
      const now = 1_000_000;
      for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
        expect(await checkHandshakeAllowed('203.0.113.9', now)).toBe(true);
      }
      expect(await checkHandshakeAllowed('203.0.113.9', now)).toBe(false);
    });

    it('tracks IPs independently', async () => {
      const now = 1_000_000;
      for (let i = 0; i <= MAX_HANDSHAKES_PER_WINDOW; i++) {
        await checkHandshakeAllowed('203.0.113.9', now);
      }
      expect(await checkHandshakeAllowed('203.0.113.9', now)).toBe(false);
      expect(await checkHandshakeAllowed('198.51.100.7', now)).toBe(true);
    });

    it('resets once the window has elapsed', async () => {
      const now = 1_000_000;
      for (let i = 0; i <= MAX_HANDSHAKES_PER_WINDOW; i++) {
        await checkHandshakeAllowed('203.0.113.9', now);
      }
      expect(await checkHandshakeAllowed('203.0.113.9', now)).toBe(false);
      expect(await checkHandshakeAllowed('203.0.113.9', now + HANDSHAKE_WINDOW_MS)).toBe(true);
    });
  });

  describe('concurrent connection cap', () => {
    it('reports capacity until the cap and none at it', async () => {
      for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) {
        expect(await hasConcurrentCapacity('203.0.113.9')).toBe(true);
        await registerConnection('203.0.113.9');
      }
      expect(await hasConcurrentCapacity('203.0.113.9')).toBe(false);
      expect(await hasConcurrentCapacity('198.51.100.7')).toBe(true);
    });

    it('frees capacity when a connection is released', async () => {
      for (let i = 0; i < MAX_CONCURRENT_PER_IP; i++) {
        await registerConnection('203.0.113.9');
      }
      expect(await hasConcurrentCapacity('203.0.113.9')).toBe(false);
      await releaseConnection('203.0.113.9');
      expect(await hasConcurrentCapacity('203.0.113.9')).toBe(true);
    });

    it('never goes negative on an unmatched release', async () => {
      await releaseConnection('203.0.113.9');
      await registerConnection('203.0.113.9');
      await releaseConnection('203.0.113.9');
      expect(await hasConcurrentCapacity('203.0.113.9')).toBe(true);
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
