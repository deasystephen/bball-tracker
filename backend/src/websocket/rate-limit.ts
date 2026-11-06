/**
 * Rate limits for the Socket.io layer (audit #16; the handshake window shared
 * across tasks since #452).
 *
 * Three protections:
 *
 *  - **Handshake attempt limit per IP** (fixed window): applied *before* token
 *    verification, so unauthenticated connect spam cannot burn a JWKS check +
 *    user lookup per attempt. Counted by a `SharedRateLimitStore` named
 *    `ws-hs` (Redis key `rl:ws-hs:<ip>`, IPv6 keyed by its /56 like the HTTP
 *    limiters), the same store, window and back-off
 *    (`utils/redis-backoff.ts#sharedRedisBackoff`) as the HTTP limiters: in
 *    Redis when it is configured and answering, in this task's memory
 *    otherwise. A Redis problem never refuses a handshake.
 *  - **Concurrent connection cap per IP**: bounds how many sockets one IP can
 *    hold open on this task. Counted on successful connections only
 *    (incremented on `connection`, decremented on `disconnect`) and checked in
 *    the pre-auth middleware. **In process memory, per task**: the cross-task
 *    version lands with the multi-replica flip, not before (#452; suggested
 *    design: a per-IP sorted set of socket ids scored by expiry, ZADD /
 *    ZREMRANGEBYSCORE / ZCARD, no per-task bookkeeping).
 *  - **`join-game` and `refresh-auth` throttles per socket** (fixed window):
 *    each join costs two DB queries plus a 100-event snapshot, each offer a
 *    JWKS check and a user lookup. A socket lives on exactly one task, so these
 *    stay in WeakMaps keyed by the socket object: the state is per socket by
 *    definition and dies with it.
 *
 * A rejected handshake surfaces to the client as `connect_error` with
 * `RATE_LIMITED_MESSAGE`; the mobile client backs off and retries the same way
 * it does for `Service unavailable` (a middleware rejection is not
 * auto-reconnected by socket.io). Limits are deliberately generous: a whole
 * team spectating from gym Wi-Fi shares one NAT IP.
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Socket } from 'socket.io';
import { SharedRateLimitStore } from '../api/middleware/rate-limit-store';
import { logger } from '../utils/logger';

export const RATE_LIMITED_MESSAGE = 'Rate limited';

export const HANDSHAKE_WINDOW_MS = 60_000;
export const MAX_HANDSHAKES_PER_WINDOW = 60;
export const MAX_CONCURRENT_PER_IP = 50;
export const JOIN_WINDOW_MS = 60_000;
export const MAX_JOINS_PER_WINDOW = 20;
export const REFRESH_AUTH_WINDOW_MS = 60_000;
/** `refresh-auth` (#49) runs a JWKS check and a user lookup; a client needs ~1 per token lifetime. */
export const MAX_REFRESH_AUTHS_PER_WINDOW = 10;

/** The handshake store's name; its Redis keys are `rl:ws-hs:<handshakeKey(ip)>`. */
export const HANDSHAKE_STORE_NAME = 'ws-hs';

interface Window {
  count: number;
  windowStart: number;
}

/**
 * The handshake window's store. express-rate-limit initialises it with its
 * fully resolved `Options` (window, limit and the rest), exactly as it does
 * for the HTTP limiters; the middleware it returns is never mounted, because
 * Socket.io calls `checkHandshakeAllowed` instead.
 */
function createHandshakeStore(): SharedRateLimitStore {
  const store = new SharedRateLimitStore(HANDSHAKE_STORE_NAME);
  rateLimit({
    windowMs: HANDSHAKE_WINDOW_MS,
    limit: MAX_HANDSHAKES_PER_WINDOW,
    store,
    passOnStoreError: true,
  });
  return store;
}

let handshakeStore = createHandshakeStore();
const concurrentByIp = new Map<string, number>();
const joinWindows = new WeakMap<object, Window>();
const refreshAuthWindows = new WeakMap<object, Window>();

/**
 * The client IP for rate-limiting purposes. Behind the ALB the peer address is
 * the load balancer's, and the ALB appends the real client to
 * `x-forwarded-for` — the *rightmost* entry is the one our trusted hop added
 * (the same "trust one proxy" rule Express uses via `trust proxy: 1`), while
 * earlier entries are client-supplied and forgeable.
 */
export function socketClientIp(socket: Socket): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  if (value) {
    const parts = value.split(',');
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return socket.handshake.address;
}

/**
 * The handshake window's key for `ip`: express-rate-limit's `ipKeyGenerator`
 * with its default IPv6 subnet (/56), the same key the HTTP limiters' default
 * `keyGenerator` uses, so one IPv6 client cannot walk its prefix to reset the
 * window. IPv4 and IPv4-mapped addresses key on the IPv4 address.
 */
export function handshakeKey(ip: string): string {
  return ipKeyGenerator(ip);
}

/**
 * Count a handshake attempt from `ip` and report whether it is within the
 * per-window budget, across all tasks. Called before authentication.
 */
export async function checkHandshakeAllowed(ip: string): Promise<boolean> {
  const { totalHits } = await handshakeStore.increment(handshakeKey(ip));
  return totalHits <= MAX_HANDSHAKES_PER_WINDOW;
}

/** Whether `ip` may open one more concurrent socket on this task. */
export function hasConcurrentCapacity(ip: string): boolean {
  return (concurrentByIp.get(ip) ?? 0) < MAX_CONCURRENT_PER_IP;
}

/**
 * Both handshake checks: the window first (the only Redis call), then the
 * in-memory capacity. Never rejects: an unexpected error allows the handshake.
 */
export async function evaluateHandshake(ip: string): Promise<boolean> {
  try {
    if (!(await checkHandshakeAllowed(ip))) return false;
    return hasConcurrentCapacity(ip);
  } catch (error) {
    logger.error('Socket handshake rate limit check failed; allowing', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * The pre-auth Socket.io middleware. `next` is called exactly once: the
 * decision is computed first and `next` runs outside any try/catch, so an
 * error thrown by downstream middleware is never answered with a second
 * `next`.
 */
export function handshakeRateLimit(socket: Socket, next: (err?: Error) => void): void {
  const ip = socketClientIp(socket);
  void evaluateHandshake(ip).then((allowed) => {
    if (allowed) {
      next();
      return;
    }
    logger.warn('Socket handshake rate limited', { socketId: socket.id, ip });
    next(new Error(RATE_LIMITED_MESSAGE));
  }).catch((error: unknown) => {
    // Only reachable if `next` itself threw; it has already been called.
    logger.error('Socket handshake middleware chain threw', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Record an established connection from `ip` (call on `connection`). */
export function registerConnection(ip: string): void {
  concurrentByIp.set(ip, (concurrentByIp.get(ip) ?? 0) + 1);
}

/** Release a connection from `ip` (call on `disconnect`). */
export function releaseConnection(ip: string): void {
  const current = concurrentByIp.get(ip) ?? 0;
  if (current <= 1) {
    concurrentByIp.delete(ip);
  } else {
    concurrentByIp.set(ip, current - 1);
  }
}

/**
 * Count a `join-game` from this socket and report whether it is within the
 * per-window budget. Cheap map bump — runs before any DB work.
 */
export function checkJoinAllowed(socket: object, now: number = Date.now()): boolean {
  const window = joinWindows.get(socket);
  if (!window || now - window.windowStart >= JOIN_WINDOW_MS) {
    joinWindows.set(socket, { count: 1, windowStart: now });
    return true;
  }
  window.count += 1;
  return window.count <= MAX_JOINS_PER_WINDOW;
}

/**
 * Count a `refresh-auth` from this socket and report whether it is within the
 * per-window budget (#49). Runs before the JWKS check and the user lookup.
 */
export function checkRefreshAuthAllowed(socket: object, now: number = Date.now()): boolean {
  const window = refreshAuthWindows.get(socket);
  if (!window || now - window.windowStart >= REFRESH_AUTH_WINDOW_MS) {
    refreshAuthWindows.set(socket, { count: 1, windowStart: now });
    return true;
  }
  window.count += 1;
  return window.count <= MAX_REFRESH_AUTHS_PER_WINDOW;
}

/** Clear this task's limiter state (in-memory handshake windows, connection counts). Test-only. */
export function resetSocketRateLimits(): void {
  handshakeStore.shutdown();
  handshakeStore = createHandshakeStore();
  concurrentByIp.clear();
}
