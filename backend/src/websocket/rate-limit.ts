/**
 * Rate limits for the Socket.io layer (audit #16; shared across tasks since
 * #452).
 *
 * Three protections:
 *
 *  - **Handshake attempt limit per IP** (fixed window): applied *before* token
 *    verification, so unauthenticated connect spam cannot burn a JWKS check +
 *    user lookup per attempt. Counted in Redis (`ws:hs:<ip>`), shared by every
 *    task.
 *  - **Concurrent connection cap per IP**: bounds how many sockets one IP can
 *    hold open across all tasks. Counted on successful connections only
 *    (registered on `connection`, released on `disconnect`) and checked in the
 *    pre-auth middleware. In Redis each task keeps its own count as a field of
 *    the hash `ws:conc:<ip>`, named by its instance id, and a task refreshes
 *    its liveness key `ws:inst:<id>` every `INSTANCE_HEARTBEAT_MS`; the check
 *    sums only the fields of live tasks and deletes the rest, so a task that
 *    crashed with sockets open stops counting within `INSTANCE_TTL_MS`. The
 *    script reads keys it is not handed in `KEYS`, which is fine on the
 *    single-node, non-cluster ElastiCache the API uses; a cluster-mode Redis
 *    would need hash tags first.
 *  - **`join-game` and `refresh-auth` throttles per socket** (fixed window):
 *    each join costs two DB queries plus a 100-event snapshot, each offer a
 *    JWKS check and a user lookup. A socket lives on exactly one task, so these
 *    stay in WeakMaps keyed by the socket object: the state is per socket by
 *    definition and dies with it.
 *
 * **Fail-open (Redis is a best-effort dependency):** with no `REDIS_URL`, while
 * the client is not connected, or when a Redis command fails or times out, the IP-keyed checks fall back to
 * this task's in-memory counters, which are always kept alongside, so the
 * limits still hold per task. A Redis problem never rejects a handshake.
 *
 * A rejected handshake surfaces to the client as `connect_error` with
 * `RATE_LIMITED_MESSAGE`; the mobile client backs off and retries the same way
 * it does for `Service unavailable` (a middleware rejection is not
 * auto-reconnected by socket.io). Limits are deliberately generous: a whole
 * team spectating from gym Wi-Fi shares one NAT IP.
 */

import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
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

/** Lazily sweep expired handshake windows once the map grows past this. */
const SWEEP_THRESHOLD = 10_000;

interface Window {
  count: number;
  windowStart: number;
}

const handshakeWindows = new Map<string, Window>();
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

/** This task's in-memory handshake window (the fallback; also kept current while Redis is up). */
function checkHandshakeAllowedLocally(ip: string, now: number): boolean {
  if (handshakeWindows.size > SWEEP_THRESHOLD) {
    for (const [key, window] of handshakeWindows) {
      if (now - window.windowStart >= HANDSHAKE_WINDOW_MS) handshakeWindows.delete(key);
    }
  }
  return hitWindow(handshakeWindows, ip, HANDSHAKE_WINDOW_MS, MAX_HANDSHAKES_PER_WINDOW, now);
}

function registerConnectionLocally(ip: string): void {
  concurrentByIp.set(ip, (concurrentByIp.get(ip) ?? 0) + 1);
}

function releaseConnectionLocally(ip: string): void {
  const current = concurrentByIp.get(ip) ?? 0;
  if (current <= 1) {
    concurrentByIp.delete(ip);
  } else {
    concurrentByIp.set(ip, current - 1);
  }
}

// ---------------------------------------------------------------------------
// Shared (Redis) counters
// ---------------------------------------------------------------------------

export const HANDSHAKE_KEY_PREFIX = 'ws:hs:';
export const CONCURRENT_KEY_PREFIX = 'ws:conc:';
export const INSTANCE_KEY_PREFIX = 'ws:inst:';
/** How long a task counts as alive after its last heartbeat. */
export const INSTANCE_TTL_MS = 60_000;
export const INSTANCE_HEARTBEAT_MS = 20_000;
/** Idle expiry of a per-IP concurrency hash, refreshed by every registration. */
export const CONCURRENT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** This process's id in the shared concurrency hashes. */
export const INSTANCE_ID = randomUUID();

/** Fixed window: INCR, and start the window's expiry on the first hit. */
const HANDSHAKE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count`;

/** KEYS[1] hash, ARGV[1] instance-key prefix: sum live tasks' counts, drop dead tasks' fields. */
const CONCURRENT_COUNT_SCRIPT = `
local fields = redis.call('HGETALL', KEYS[1])
local total = 0
for i = 1, #fields, 2 do
  if redis.call('EXISTS', ARGV[1] .. fields[i]) == 1 then
    total = total + tonumber(fields[i + 1])
  else
    redis.call('HDEL', KEYS[1], fields[i])
  end
end
return total`;

/**
 * KEYS[1] hash, KEYS[2] this task's liveness key; ARGV[1] instance id, ARGV[2]
 * hash TTL ms, ARGV[3] liveness TTL ms. Marks the task alive in the same step,
 * so a field never exists without its liveness key.
 */
const REGISTER_SCRIPT = `
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
return 1`;

/** KEYS[1] hash, ARGV[1] instance id. Never leaves a field at or below zero. */
const RELEASE_SCRIPT = `
local count = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if count <= 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
end
return count`;

let heartbeat: NodeJS.Timeout | null = null;
let outageLogged = false;

/**
 * Run one shared-counter command; `null` when Redis is not configured or the
 * command failed (logged once per outage), so the caller falls back to memory.
 */
async function runShared(operation: string, script: string, keys: string[], args: Array<string | number>): Promise<number | null> {
  const client = getReadyRedisClient();
  if (!client) return null;
  try {
    const result = await client.eval(script, keys.length, ...keys, ...args);
    if (outageLogged) {
      outageLogged = false;
      logger.info('Socket rate limit: Redis recovered');
    }
    return Number(result);
  } catch (error) {
    if (!outageLogged) {
      outageLogged = true;
      logger.warn('Socket rate limit: Redis unavailable, counting in memory', {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

/**
 * Keep this task's liveness key fresh every `INSTANCE_HEARTBEAT_MS` (started on
 * the first connection; each registration also sets it).
 */
function ensureHeartbeat(): void {
  if (heartbeat) return;
  const beat = (): void => {
    const client = getReadyRedisClient();
    if (!client) return;
    client.set(`${INSTANCE_KEY_PREFIX}${INSTANCE_ID}`, '1', 'PX', INSTANCE_TTL_MS).catch(() => {
      // The next beat retries; missed beats past INSTANCE_TTL_MS only make
      // this task's sockets stop counting toward the shared cap (fail-open).
    });
  };
  heartbeat = setInterval(beat, INSTANCE_HEARTBEAT_MS);
  heartbeat.unref();
}

/**
 * Count a handshake attempt from `ip` and report whether it is within the
 * per-window budget, across all tasks. Called before authentication. The local
 * window is always counted too and decides when Redis cannot.
 */
export async function checkHandshakeAllowed(ip: string, now: number = Date.now()): Promise<boolean> {
  const local = checkHandshakeAllowedLocally(ip, now);
  const shared = await runShared('handshake', HANDSHAKE_SCRIPT, [`${HANDSHAKE_KEY_PREFIX}${ip}`], [HANDSHAKE_WINDOW_MS]);
  return shared === null ? local : shared <= MAX_HANDSHAKES_PER_WINDOW;
}

/** Whether `ip` may open one more concurrent socket, across all tasks. */
export async function hasConcurrentCapacity(ip: string): Promise<boolean> {
  const shared = await runShared('concurrent-count', CONCURRENT_COUNT_SCRIPT, [`${CONCURRENT_KEY_PREFIX}${ip}`], [INSTANCE_KEY_PREFIX]);
  const count = shared ?? concurrentByIp.get(ip) ?? 0;
  return count < MAX_CONCURRENT_PER_IP;
}

/** Record an established connection from `ip` (call on `connection`). */
export async function registerConnection(ip: string): Promise<void> {
  registerConnectionLocally(ip);
  if (!getRedisClient()) return;
  ensureHeartbeat();
  await runShared(
    'concurrent-register',
    REGISTER_SCRIPT,
    [`${CONCURRENT_KEY_PREFIX}${ip}`, `${INSTANCE_KEY_PREFIX}${INSTANCE_ID}`],
    [INSTANCE_ID, CONCURRENT_KEY_TTL_MS, INSTANCE_TTL_MS]
  );
}

/** Release a connection from `ip` (call on `disconnect`). */
export async function releaseConnection(ip: string): Promise<void> {
  releaseConnectionLocally(ip);
  await runShared('concurrent-release', RELEASE_SCRIPT, [`${CONCURRENT_KEY_PREFIX}${ip}`], [INSTANCE_ID]);
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

/** Clear this task's limiter state and stop the heartbeat. Test-only. */
export function resetSocketRateLimits(): void {
  handshakeWindows.clear();
  concurrentByIp.clear();
  outageLogged = false;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}
