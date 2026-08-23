/**
 * In-memory rate limits for the Socket.io layer (audit #16).
 *
 * Three protections, all keyed in module state (single-replica only, like the
 * in-memory Socket.io adapter — see the startup guard in `src/index.ts` and
 * issue #26; counters reset on process restart, which is fine for abuse caps):
 *
 *  - **Handshake attempt limit per IP** (fixed window): applied *before* token
 *    verification, so unauthenticated connect spam cannot burn a JWKS check +
 *    user lookup per attempt.
 *  - **Concurrent connection cap per IP**: bounds how many sockets one IP can
 *    hold open. Counted on successful connections only (incremented on
 *    `connection`, decremented on `disconnect`) and checked in the pre-auth
 *    middleware.
 *  - **`join-game` throttle per socket** (fixed window): each join costs two
 *    DB queries plus a 100-event snapshot, so a connected socket cannot spam
 *    it. Tracked in a WeakMap so state dies with the socket.
 *
 * A rejected handshake surfaces to the client as `connect_error` with
 * `RATE_LIMITED_MESSAGE`; the mobile client backs off and retries the same way
 * it does for `Service unavailable` (a middleware rejection is not
 * auto-reconnected by socket.io). Limits are deliberately generous: a whole
 * team spectating from gym Wi-Fi shares one NAT IP.
 */

import type { Socket } from 'socket.io';

export const RATE_LIMITED_MESSAGE = 'Rate limited';

export const HANDSHAKE_WINDOW_MS = 60_000;
export const MAX_HANDSHAKES_PER_WINDOW = 60;
export const MAX_CONCURRENT_PER_IP = 50;
export const JOIN_WINDOW_MS = 60_000;
export const MAX_JOINS_PER_WINDOW = 20;

/** Lazily sweep expired handshake windows once the map grows past this. */
const SWEEP_THRESHOLD = 10_000;

interface Window {
  count: number;
  windowStart: number;
}

const handshakeWindows = new Map<string, Window>();
const concurrentByIp = new Map<string, number>();
const joinWindows = new WeakMap<object, Window>();

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

function hitWindow(
  store: Map<string, Window>,
  key: string,
  windowMs: number,
  max: number,
  now: number
): boolean {
  const window = store.get(key);
  if (!window || now - window.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return true;
  }
  window.count += 1;
  return window.count <= max;
}

/**
 * Count a handshake attempt from `ip` and report whether it is within the
 * per-window budget. Called before authentication.
 */
export function checkHandshakeAllowed(ip: string, now: number = Date.now()): boolean {
  if (handshakeWindows.size > SWEEP_THRESHOLD) {
    for (const [key, window] of handshakeWindows) {
      if (now - window.windowStart >= HANDSHAKE_WINDOW_MS) handshakeWindows.delete(key);
    }
  }
  return hitWindow(handshakeWindows, ip, HANDSHAKE_WINDOW_MS, MAX_HANDSHAKES_PER_WINDOW, now);
}

/** Whether `ip` may open one more concurrent socket. */
export function hasConcurrentCapacity(ip: string): boolean {
  return (concurrentByIp.get(ip) ?? 0) < MAX_CONCURRENT_PER_IP;
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

/** Clear all limiter state. Test-only. */
export function resetSocketRateLimits(): void {
  handshakeWindows.clear();
  concurrentByIp.clear();
}
