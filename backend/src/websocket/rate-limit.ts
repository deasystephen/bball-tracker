/**
 * Rate limits for the Socket.io layer (audit #16; shared across tasks since
 * #452).
 *
 * Three protections:
 *
 *  - **Handshake attempt limit per IP** (fixed window): applied *before* token
 *    verification, so unauthenticated connect spam cannot burn a JWKS check +
 *    user lookup per attempt. Counted by a `SharedRateLimitStore` named
 *    `ws-hs` (Redis key `rl:ws-hs:<ip>`), the same store, window and back-off
 *    policy as the HTTP limiters.
 *  - **Concurrent connection cap per IP**: bounds how many sockets one IP can
 *    hold open across all tasks. Counted on successful connections only
 *    (registered on `connection`, released on `disconnect`) and checked in the
 *    pre-auth middleware. This task's count in `concurrentByIp` is the source
 *    of truth for its own sockets. In Redis each task writes its **absolute**
 *    count for an IP as a field of the hash `ws:conc:<ip>` (named by its
 *    instance id, deleted at 0) on every change and again on every heartbeat,
 *    and marks itself alive with `ws:inst:<id>`. A write lost to a Redis blip
 *    is therefore corrected by the next successful one instead of drifting
 *    for good. The capacity check is the live *other* tasks' fields plus this
 *    task's local count; fields of tasks whose liveness key expired are
 *    deleted as they are read, so a crashed task stops counting within
 *    `INSTANCE_TTL_MS`. The scripts read keys they are not handed in `KEYS`,
 *    which is fine on the single-node, non-cluster ElastiCache the API uses;
 *    a cluster-mode Redis would need hash tags first.
 *  - **`join-game` and `refresh-auth` throttles per socket** (fixed window):
 *    each join costs two DB queries plus a 100-event snapshot, each offer a
 *    JWKS check and a user lookup. A socket lives on exactly one task, so these
 *    stay in WeakMaps keyed by the socket object: the state is per socket by
 *    definition and dies with it.
 *
 * **Fail-open (Redis is a best-effort dependency):** with no `REDIS_URL`, while
 * the client is not ready, or after a Redis failure (then for the shared
 * back-off, `RedisBackoff`), the handshake window is counted in memory and the
 * capacity check uses this task's local count alone. Neither ever refuses a
 * handshake because of Redis.
 *
 * A rejected handshake surfaces to the client as `connect_error` with
 * `RATE_LIMITED_MESSAGE`; the mobile client backs off and retries the same way
 * it does for `Service unavailable` (a middleware rejection is not
 * auto-reconnected by socket.io). Limits are deliberately generous: a whole
 * team spectating from gym Wi-Fi shares one NAT IP.
 */

import { randomUUID } from 'node:crypto';
import type { Options } from 'express-rate-limit';
import type { Socket } from 'socket.io';
import { RedisBackoff, SharedRateLimitStore } from '../api/middleware/rate-limit-store';
import { getReadyRedisClient, getRedisClient } from '../utils/redis';
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

/** The handshake store's name; its Redis keys are `rl:ws-hs:<ip>`. */
export const HANDSHAKE_STORE_NAME = 'ws-hs';
export const CONCURRENT_KEY_PREFIX = 'ws:conc:';
export const INSTANCE_KEY_PREFIX = 'ws:inst:';
/** How long a task, and an IP hash nobody rewrites, counts after its last write. */
export const INSTANCE_TTL_MS = 60_000;
export const INSTANCE_HEARTBEAT_MS = 20_000;

/** This process's id in the shared concurrency hashes. */
export const INSTANCE_ID = randomUUID();

interface Window {
  count: number;
  windowStart: number;
}

function createHandshakeStore(): SharedRateLimitStore {
  const store = new SharedRateLimitStore(HANDSHAKE_STORE_NAME);
  store.init({ windowMs: HANDSHAKE_WINDOW_MS } as Options);
  return store;
}

let handshakeStore = createHandshakeStore();
const concurrentByIp = new Map<string, number>();
const joinWindows = new WeakMap<object, Window>();
const refreshAuthWindows = new WeakMap<object, Window>();

/** IPs whose absolute count has not reached Redis since it last changed. */
const unsynced = new Set<string>();
const concurrencyBackoff = new RedisBackoff();
let heartbeat: NodeJS.Timeout | null = null;

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

// ---------------------------------------------------------------------------
// Shared concurrency counters
// ---------------------------------------------------------------------------

/**
 * KEYS[1] hash; ARGV[1] instance-key prefix, ARGV[2] this task's id. Sums the
 * live *other* tasks' counts and deletes dead tasks' fields.
 */
const OTHERS_COUNT_SCRIPT = `
local fields = redis.call('HGETALL', KEYS[1])
local total = 0
for i = 1, #fields, 2 do
  if fields[i] ~= ARGV[2] then
    if redis.call('EXISTS', ARGV[1] .. fields[i]) == 1 then
      total = total + tonumber(fields[i + 1])
    else
      redis.call('HDEL', KEYS[1], fields[i])
    end
  end
end
return total`;

/**
 * KEYS[1] hash, KEYS[2] this task's liveness key; ARGV[1] task id, ARGV[2]
 * absolute count, ARGV[3] TTL ms. Writes the count (deletes the field at 0)
 * and marks the task alive in one step.
 */
const SYNC_SCRIPT = `
if tonumber(ARGV[2]) > 0 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
else
  redis.call('HDEL', KEYS[1], ARGV[1])
end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
return 1`;

/** The shared client if it may be used now, else `null` (count locally). */
function concurrencyClient(): ReturnType<typeof getReadyRedisClient> {
  return concurrencyBackoff.available() ? getReadyRedisClient() : null;
}

/** Write this task's absolute count for `ip`; on any miss, leave it for the heartbeat. */
async function syncIp(ip: string): Promise<void> {
  const client = concurrencyClient();
  if (!client) {
    unsynced.add(ip);
    return;
  }
  const count = concurrentByIp.get(ip) ?? 0;
  try {
    await client.eval(
      SYNC_SCRIPT,
      2,
      `${CONCURRENT_KEY_PREFIX}${ip}`,
      `${INSTANCE_KEY_PREFIX}${INSTANCE_ID}`,
      INSTANCE_ID,
      count,
      INSTANCE_TTL_MS
    );
    concurrencyBackoff.succeeded();
    // A change made while this write was in flight re-queued the IP itself.
    if ((concurrentByIp.get(ip) ?? 0) === count) unsynced.delete(ip);
  } catch (error) {
    concurrencyBackoff.failed('concurrent-sync', error);
    unsynced.add(ip);
  }
}

/**
 * Every `INSTANCE_HEARTBEAT_MS`: rewrite every IP this task holds sockets for
 * (refreshing its liveness key and the hashes' expiry) and every IP whose last
 * write was lost. Stops itself once there is nothing left to write, and is
 * restarted by the next change.
 */
async function heartbeatTick(): Promise<void> {
  const ips = new Set<string>([...concurrentByIp.keys(), ...unsynced]);
  if (ips.size === 0) {
    stopHeartbeat();
    return;
  }
  await Promise.all([...ips].map((ip) => syncIp(ip)));
}

function ensureHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => void heartbeatTick(), INSTANCE_HEARTBEAT_MS);
  heartbeat.unref();
}

function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/** Whether the heartbeat is running. Test-only. */
export function isHeartbeatRunning(): boolean {
  return heartbeat !== null;
}

/** Live other tasks' count for `ip`, or 0 when Redis cannot answer (fail-open). */
async function otherTasksCount(ip: string): Promise<number> {
  const client = concurrencyClient();
  if (!client) return 0;
  try {
    const total = await client.eval(
      OTHERS_COUNT_SCRIPT,
      1,
      `${CONCURRENT_KEY_PREFIX}${ip}`,
      INSTANCE_KEY_PREFIX,
      INSTANCE_ID
    );
    concurrencyBackoff.succeeded();
    return Number(total) || 0;
  } catch (error) {
    concurrencyBackoff.failed('concurrent-count', error);
    return 0;
  }
}

/** A connection count changed on this task: write it now and keep it fresh. */
function connectionCountChanged(ip: string): Promise<void> {
  if (!getRedisClient()) return Promise.resolve();
  ensureHeartbeat();
  return syncIp(ip);
}

// ---------------------------------------------------------------------------
// Public checks
// ---------------------------------------------------------------------------

/**
 * Count a handshake attempt from `ip` and report whether it is within the
 * per-window budget, across all tasks. Called before authentication.
 */
export async function checkHandshakeAllowed(ip: string): Promise<boolean> {
  const { totalHits } = await handshakeStore.increment(ip);
  return totalHits <= MAX_HANDSHAKES_PER_WINDOW;
}

/** Whether `ip` may open one more concurrent socket, across all tasks. */
export async function hasConcurrentCapacity(ip: string): Promise<boolean> {
  const total = (await otherTasksCount(ip)) + (concurrentByIp.get(ip) ?? 0);
  return total < MAX_CONCURRENT_PER_IP;
}

/**
 * Both handshake checks, run in parallel (one round trip each, issued
 * together). Never rejects: an unexpected error allows the handshake.
 */
export async function evaluateHandshake(ip: string): Promise<boolean> {
  try {
    const [withinWindow, hasCapacity] = await Promise.all([
      checkHandshakeAllowed(ip),
      hasConcurrentCapacity(ip),
    ]);
    return withinWindow && hasCapacity;
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
export async function registerConnection(ip: string): Promise<void> {
  concurrentByIp.set(ip, (concurrentByIp.get(ip) ?? 0) + 1);
  await connectionCountChanged(ip);
}

/** Release a connection from `ip` (call on `disconnect`). */
export async function releaseConnection(ip: string): Promise<void> {
  const current = concurrentByIp.get(ip) ?? 0;
  if (current <= 1) {
    concurrentByIp.delete(ip);
  } else {
    concurrentByIp.set(ip, current - 1);
  }
  await connectionCountChanged(ip);
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

/** Run one heartbeat now. Test-only. */
export function runHeartbeatNow(): Promise<void> {
  return heartbeatTick();
}

/** Clear this task's limiter state and stop the heartbeat. Test-only. */
export function resetSocketRateLimits(): void {
  handshakeStore.shutdown();
  handshakeStore = createHandshakeStore();
  concurrentByIp.clear();
  unsynced.clear();
  concurrencyBackoff.reset();
  stopHeartbeat();
}
