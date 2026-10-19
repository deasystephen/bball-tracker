/**
 * Socket.io handlers for live game event broadcast.
 *
 * Protocol
 *  - Client authenticates on the handshake by supplying `auth.token` (same
 *    bearer token used on the REST API — WorkOS access token or dev token).
 *  - Client emits `join-game` with `{ gameId }`. Server verifies the user can
 *    view the game using the same rules as `GET /games/:id` (canAccessTeam).
 *    On success the socket joins room `game:<gameId>` and receives a
 *    `game-snapshot` event with the current game state + recent events.
 *  - Client may emit `leave-game` with `{ gameId }` to leave the room.
 *  - Server broadcasts `game-event` to `game:<gameId>` whenever an event is
 *    persisted (via `emitGameEvent`).
 *  - Server broadcasts `game-status-change` to `game:<gameId>` whenever a
 *    game transitions state (via `emitGameStatusChange`).
 *  - Client emits `refresh-auth` with `{ token }` after each token refresh;
 *    the socket keeps its connection on the new token (#49). Without one the
 *    server re-verifies at expiry (at most every 15 minutes); on failure it
 *    emits `reauth_required` and closes the transport, and the client
 *    reconnects with a fresh token.
 *  - Socket.io's built-in ping/pong handles heartbeats. Clients that reconnect
 *    must re-emit `join-game` to resubscribe; they will receive a fresh
 *    `game-snapshot`.
 *
 * Target concurrency
 *  - 50 concurrent spectators per game on a single ECS task is the GA target.
 *    For higher fan-out, add the `@socket.io/redis-adapter` (out of scope
 *    for this change; see issue #452).
 */

import type { Server as SocketServer, Socket } from 'socket.io';
import { UserRole, type GameEvent, type GameStatus, type Prisma } from '@prisma/client';
import prisma from '../models';
import { canAccessTeam, readableTeamsWhere } from '../utils/permissions';
import { JWT_CLOCK_TOLERANCE_SECONDS, WorkOSService } from '../services/workos-service';
import { logger } from '../utils/logger';
import { USER_SUMMARY_SELECT, type UserSummary } from '../utils/user-select';
import { captureException, isExpectedClientError } from '../utils/sentry';
import {
  RATE_LIMITED_MESSAGE,
  checkHandshakeAllowed,
  checkJoinAllowed,
  checkRefreshAuthAllowed,
  hasConcurrentCapacity,
  registerConnection,
  releaseConnection,
  socketClientIp,
} from './rate-limit';

export const GAME_ROOM_PREFIX = 'game:';
export const SNAPSHOT_EVENT_LIMIT = 100;

export interface AuthenticatedSocketUser {
  id: string;
  email: string | null;
  name: string;
  role: string;
}

/**
 * Extend the Socket type with the authenticated user we attach during the
 * handshake middleware. Socket.io exposes arbitrary fields on `socket.data`
 * without type checking — we use a narrow interface so downstream handlers
 * don't need to use `any`.
 */
export interface GameSocketData {
  user: AuthenticatedSocketUser;
  /** Epoch ms at which the current token expires; null when it carries no `exp`. */
  tokenExpiresAt: number | null;
  /**
   * The newest bearer token this socket has proven: the handshake token, then
   * each accepted `refresh-auth`. Server memory only; never logged.
   */
  authToken?: string;
  /** Per-socket jitter added to the re-check grace (#49), fixed at first schedule. */
  reauthJitterMs?: number;
  /**
   * The most recent token offered by `refresh-auth`. A verification that
   * finishes after a newer offer is discarded, so out-of-order completions
   * can never leave the socket on the older token (#49).
   */
  latestOfferedToken?: string;
  /** True while the latest `refresh-auth` offer is still being verified. */
  offerPending?: boolean;
  /** Set once an expiry cut-off was deferred for a pending offer (one deferral only). */
  expiryDeferred?: boolean;
  /** The current token's lifetime (`exp - iat`) in ms, when known; bounds an outage hold. */
  tokenLifetimeMs?: number | null;
}

// We intentionally keep the event-map generics at their default (untyped) and
// only parameterize `SocketData`. Typing the full event maps provides little
// value here (event names are string literals at the call site) and would
// force `socket.emit` to reject dynamic payloads.
export type GameSocket = Socket & { data: GameSocketData };

export function gameRoom(gameId: string): string {
  return `${GAME_ROOM_PREFIX}${gameId}`;
}

export interface SocketSession {
  user: AuthenticatedSocketUser;
  /** Epoch ms at which the token expires; null when it carries no expiry. */
  expiresAt: number | null;
  /** `exp - iat` in ms; null when the token carries no `iat` (dev tokens). */
  lifetimeMs: number | null;
}

/**
 * When the last verification threw an outage (JWKS unreachable, database
 * failover), or null once one completed again. Every socket verification
 * (handshake, `refresh-auth`, re-check) updates it, so it reflects the most
 * recent attempt across the process (#49).
 */
let verifierDownSince: number | null = null;

/** True while the most recent socket verification failed with an outage. */
export function isSocketVerifierDown(): boolean {
  return verifierDownSince !== null;
}

/** Forget the outage marker. Test-only. */
export function resetSocketVerifierHealth(): void {
  verifierDownSince = null;
}

/**
 * Resolve a bearer-style token to a local user and the token's expiry (see
 * `resolveSessionFromToken`), recording whether the verifier is reachable: a
 * throw that is not a 4xx AppError marks an outage, anything else clears it.
 */
export async function resolveSocketSession(
  rawToken: string | undefined
): Promise<SocketSession | null> {
  try {
    const session = await resolveSessionFromToken(rawToken);
    verifierDownSince = null;
    return session;
  } catch (error) {
    if (isExpectedClientError(error)) {
      verifierDownSince = null;
    } else if (verifierDownSince === null) {
      verifierDownSince = Date.now();
    }
    throw error;
  }
}

/**
 * Resolve a bearer-style token to a local user and the token's expiry. Mirrors
 * the logic in `src/api/auth/middleware.ts` but returns a plain value instead
 * of mutating an Express request. Returns `null` when the token is
 * invalid/expired or the user does not exist or is a tombstone (`deletedAt`
 * set).
 */
async function resolveSessionFromToken(
  rawToken: string | undefined
): Promise<SocketSession | null> {
  if (!rawToken || typeof rawToken !== 'string') {
    return null;
  }

  // Accept both "Bearer <token>" and bare tokens for flexibility in clients.
  const token = rawToken.startsWith('Bearer ') ? rawToken.substring(7) : rawToken;

  // Dev token path (development only) — matches REST middleware.
  if (process.env.NODE_ENV === 'development' && token.startsWith('dev_')) {
    try {
      const decoded = JSON.parse(
        Buffer.from(token.substring(4), 'base64').toString()
      ) as { userId?: unknown; exp?: unknown };

      // A numeric string would pass `<` by coercion and then string-concatenate
      // in the re-auth arithmetic, so both claims must have the right type.
      if (
        typeof decoded.userId !== 'string' ||
        typeof decoded.exp !== 'number' ||
        !Number.isFinite(decoded.exp) ||
        decoded.exp < Date.now()
      ) {
        return null;
      }

      // Dev tokens resolve by id, so a deleted account (#444) must be refused
      // explicitly, as the REST middleware does (#667).
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, deletedAt: null },
        select: { id: true, email: true, name: true, role: true },
      });
      // Dev token `exp` is epoch milliseconds.
      return user ? { user, expiresAt: decoded.exp, lifetimeMs: null } : null;
    } catch {
      return null;
    }
  }

  const workosUser = await WorkOSService.verifyToken(token);
  if (!workosUser) {
    return null;
  }

  // Deletion nulls workosUserId, but `deletedAt` is the tombstone signal (#667).
  const user = await prisma.user.findUnique({
    where: { workosUserId: workosUser.id, deletedAt: null },
    select: { id: true, email: true, name: true, role: true },
  });
  // A WorkOS `exp` and `iat` are epoch seconds.
  const lifetimeMs =
    typeof workosUser.issuedAt === 'number'
      ? (workosUser.expiresAt - workosUser.issuedAt) * 1000
      : null;
  return user ? { user, expiresAt: workosUser.expiresAt * 1000, lifetimeMs } : null;
}

/** The bearer token a socket presented at its handshake. */
function handshakeToken(socket: GameSocket): string | undefined {
  const authPayload = socket.handshake.auth as { token?: string } | undefined;
  return authPayload?.token ?? socket.handshake.headers.authorization;
}

/**
 * Socket.io connection authentication middleware. Runs once per socket during
 * the handshake. Records the token's expiry so the connection handler can
 * schedule the re-verification below (#49).
 */
export async function authenticateSocket(
  socket: GameSocket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const session = await resolveSocketSession(handshakeToken(socket));
    if (!session) {
      next(new Error('Unauthorized'));
      return;
    }

    socket.data.user = session.user;
    socket.data.tokenExpiresAt = session.expiresAt;
    socket.data.tokenLifetimeMs = session.lifetimeMs;
    socket.data.authToken = handshakeToken(socket);
    next();
  } catch (error) {
    logger.error('Socket authentication failed', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // A rejected token returns null from resolveSocketSession and never throws, so
    // a throw is either an expected client error (a 4xx AppError, kept out of
    // Sentry like the REST path does) or an outage/defect: JWKS unreachable,
    // the database failing over. Middleware errors never reach the Express
    // chain (sentryErrorHandler), so report the latter here, the way the REST
    // path reports the same ServiceUnavailableError as a 503 (#672).
    if (isExpectedClientError(error)) {
      next(new Error('Unauthorized'));
      return;
    }
    captureException(error, { flow: 'socket-auth', socketId: socket.id });
    // An outage is not a rejected token — tell the client so it backs off and
    // retries instead of refreshing its credentials and logging out.
    next(new Error('Service unavailable'));
  }
}

// ---------------------------------------------------------------------------
// Mid-session re-verification (#49)
//
// A socket's handshake token is checked once at connect, so without this an
// access token that expired mid-game would stay authorized until the client
// disconnected. Two mechanisms:
//
// 1. In-band refresh (the normal path). Whenever the client refreshes its
//    access token it emits `refresh-auth { token }`. `handleRefreshAuth` runs
//    the token through `resolveSocketSession`; if it is valid and names the
//    same user, the socket keeps its connection and its rooms, `socket.data`
//    takes the new token and expiry, room access is re-checked and the timer
//    below is rescheduled. No disconnect, no new handshake, no snapshot.
// 2. The re-check timer (the fallback). Each socket has one timer, due at the
//    current token's expiry plus REAUTH_GRACE_MS (longer than the verifier's
//    clock tolerance, so the re-check really fails) plus a per-socket jitter
//    (so expiries that cluster at tip-off do not all close in one second),
//    and never more than REAUTH_MAX_INTERVAL_MS away. When it fires, a token
//    past its expiry plus grace is known dead and cut off with no verify
//    (`handleExpiredToken` waits once for a `refresh-auth` still being
//    verified, and holds the socket through a verifier outage, bounded by one
//    extra token lifetime, because the client could not reconnect during it);
//    otherwise (no `exp`, or a long-lived token hitting the interval cap) the
//    held token is re-run through `resolveSocketSession`:
//      - still valid → refresh
//        `socket.data`, re-check room access, schedule the next check;
//      - rejected → emit `reauth_required` and close the Engine.IO
//        connection (`socket.conn.close()`). Not `socket.disconnect()`: with
//        or without `true` it sends a namespace DISCONNECT, which
//        socket.io-client reports as `io server disconnect` and never
//        auto-reconnects from. A transport close is `transport close` on the
//        client, which auto-reconnects, so a client that never sends
//        `refresh-auth` (built before #49) gets `connect_error:
//        Unauthorized`, refreshes and connects again;
//      - a 4xx AppError is a rejection; any other throw (JWKS or database
//        outage) goes to Sentry and is retried after REAUTH_RETRY_MS, so an
//        outage never cuts off a valid session (an expired one is cut off at
//        the next check without a verify).
//    Both async paths capture the token they verify and discard the result
//    if a newer token was accepted or offered meanwhile.
//
// Room re-checks (`pruneGameRooms`, audit #72) leave every game room the user
// can no longer view (one `game.findMany` over `readableTeamsWhere` for the
// whole set, the same rule `canViewGame` applies to a single join), so a removed coach stops receiving
// broadcasts at the next refresh or re-check rather than at disconnect.
// Timers live in process memory, like rooms and rate-limit counters (the API
// is single-replica), and are cleared on disconnect.
// ---------------------------------------------------------------------------

/** Client → server: a fresh access token for the open connection. */
export const REFRESH_AUTH_EVENT = 'refresh-auth';
/** Server → client event sent just before a re-auth transport close. */
export const REAUTH_REQUIRED_EVENT = 'reauth_required';
/** Wait this long past `exp`: the verifier accepts a token for its clock tolerance. */
export const REAUTH_GRACE_MS = (JWT_CLOCK_TOLERANCE_SECONDS + 5) * 1000;
/** Upper bound of the per-socket jitter added to the grace. */
export const REAUTH_JITTER_MAX_MS = 20 * 1000;
/** Upper bound between checks, and the interval for a token without `exp`. */
export const REAUTH_MAX_INTERVAL_MS = 15 * 60 * 1000;
/** Re-check delay after the verifier threw on a token that has not expired. */
export const REAUTH_RETRY_MS = 60 * 1000;
/** How long an expiry cut-off waits, once, for a `refresh-auth` still being verified. */
export const REAUTH_PENDING_OFFER_WAIT_MS = 10 * 1000;

const reauthTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Delay until a socket's next re-verification. */
export function reauthDelayMs(
  expiresAt: number | null,
  now: number = Date.now(),
  jitterMs = 0
): number {
  if (expiresAt === null || !Number.isFinite(expiresAt)) {
    return REAUTH_MAX_INTERVAL_MS;
  }
  return Math.min(
    Math.max(expiresAt - now, 0) + REAUTH_GRACE_MS + jitterMs,
    REAUTH_MAX_INTERVAL_MS
  );
}

/** Number of sockets with a pending re-verification (for leak tests). */
export function pendingReauthCount(): number {
  return reauthTimers.size;
}

/** True while a socket has a re-verification scheduled (for leak tests). */
export function hasPendingReauth(socketId: string): boolean {
  return reauthTimers.has(socketId);
}

/** Cancel a socket's pending re-verification. Safe to call more than once. */
export function clearSocketReauth(socketId: string): void {
  const timer = reauthTimers.get(socketId);
  if (timer) {
    clearTimeout(timer);
    reauthTimers.delete(socketId);
  }
}

/** Schedule (or reschedule) a socket's next re-verification. */
export function scheduleSocketReauth(socket: GameSocket, delayMs?: number): void {
  clearSocketReauth(socket.id);
  if (socket.data.reauthJitterMs === undefined) {
    socket.data.reauthJitterMs = Math.floor(Math.random() * REAUTH_JITTER_MAX_MS);
  }
  const delay =
    delayMs ??
    reauthDelayMs(socket.data.tokenExpiresAt ?? null, Date.now(), socket.data.reauthJitterMs);
  const timer = setTimeout(() => {
    reauthTimers.delete(socket.id);
    void reverifySocket(socket);
  }, delay);
  // Never keep the process alive for a re-check.
  timer.unref();
  reauthTimers.set(socket.id, timer);
}

/**
 * True when the held token's expiry, plus `graceMs`, has passed. With the full
 * grace (past the verifier's clock tolerance) the token is known dead without
 * a JWKS check or a user lookup.
 */
function pastExpiry(socket: GameSocket, graceMs = 0, now: number = Date.now()): boolean {
  const expiresAt = socket.data.tokenExpiresAt ?? null;
  return expiresAt !== null && Number.isFinite(expiresAt) && expiresAt + graceMs <= now;
}

/** The token the server currently holds for a socket. */
function heldToken(socket: GameSocket): string | undefined {
  return socket.data.authToken ?? handshakeToken(socket);
}

/** Why a socket was cut off. Only `expired` is the expected cycle. */
export type ReauthReason = 'expired' | 'rejected' | 'user_changed';

function requireReauth(socket: GameSocket, reason: ReauthReason): void {
  clearSocketReauth(socket.id);
  const meta = { socketId: socket.id, userId: socket.data.user?.id, reason };
  // An expired token on a client that never sent `refresh-auth` is the
  // expected cycle; a rejected unexpired token, a deleted account or a
  // different user is an anomaly worth seeing at the production level.
  if (reason === 'expired') {
    logger.debug('Socket reauth required', meta);
  } else {
    logger.info('Socket reauth required', meta);
  }
  socket.emit(REAUTH_REQUIRED_EVENT, {});
  // Engine.IO flushes the queued event before it closes the transport.
  socket.conn.close();
}

/**
 * The subset of `gameIds` the user may view live: the same rule as
 * `canViewGame` (system ADMIN, or the game's team passes the caller-access
 * clause), resolved for the whole set in one `game.findMany` over
 * `readableTeamsWhere` (#49).
 */
export async function viewableGameIds(userId: string, gameIds: string[]): Promise<Set<string>> {
  if (gameIds.length === 0) return new Set();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  const where: Prisma.GameWhereInput = { id: { in: gameIds } };
  if (user?.role !== UserRole.ADMIN) {
    where.team = await readableTeamsWhere(userId);
  }
  const rows = await prisma.game.findMany({ where, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

/**
 * Leave every game room the socket's user can no longer view (audit #72): the
 * set difference between the rooms and `viewableGameIds`. Returns the game ids
 * left. A lookup failure keeps the rooms (reported to Sentry); the next
 * refresh or re-check tries again.
 */
export async function pruneGameRooms(socket: GameSocket): Promise<string[]> {
  const userId = socket.data.user.id;
  const gameIds = [...socket.rooms]
    .filter((room) => room.startsWith(GAME_ROOM_PREFIX))
    .map((room) => room.slice(GAME_ROOM_PREFIX.length));
  if (gameIds.length === 0) return [];
  try {
    const viewable = await viewableGameIds(userId, gameIds);
    const left = gameIds.filter((gameId) => !viewable.has(gameId));
    await Promise.all(
      left.map(async (gameId) => {
        await socket.leave(gameRoom(gameId));
        logger.info('Socket evicted from game room', { socketId: socket.id, userId, gameId });
      })
    );
    return left;
  } catch (error) {
    logger.warn('Socket room re-check failed', {
      socketId: socket.id,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, { flow: 'socket-reauth', socketId: socket.id });
    return [];
  }
}

/** Adopt a verified session for the same user, re-check rooms, reschedule. */
async function adoptSession(socket: GameSocket, session: SocketSession): Promise<void> {
  socket.data.user = session.user;
  socket.data.tokenExpiresAt = session.expiresAt;
  socket.data.tokenLifetimeMs = session.lifetimeMs;
  socket.data.expiryDeferred = false;
  await pruneGameRooms(socket);
  if (socket.connected) scheduleSocketReauth(socket);
}

export type ReverifyOutcome = 'kept' | 'reauth_required' | 'retry' | 'deferred' | 'skipped';

/**
 * True once a held token is past its expiry by more than one more token
 * lifetime (or REAUTH_MAX_INTERVAL_MS when the lifetime is unknown): the bound
 * on keeping a socket through a verifier outage.
 */
function pastOutageBound(socket: GameSocket, now: number = Date.now()): boolean {
  const extra = socket.data.tokenLifetimeMs ?? REAUTH_MAX_INTERVAL_MS;
  return pastExpiry(socket, Math.max(extra, REAUTH_GRACE_MS), now);
}

/**
 * The held token is past its expiry plus grace, so it is dead. Cut the socket
 * off, except in two cases (#49):
 *   - a `refresh-auth` offer is still being verified → wait for it, once, for
 *     REAUTH_PENDING_OFFER_WAIT_MS;
 *   - the verifier is down → the client could not reconnect either (its
 *     handshake would get `Service unavailable`), so keep the socket and
 *     retry, until a verify completes again (then cut) or the outage bound
 *     passes.
 */
async function handleExpiredToken(socket: GameSocket): Promise<ReverifyOutcome> {
  const ids = { socketId: socket.id, userId: socket.data.user?.id };

  if (socket.data.offerPending && !socket.data.expiryDeferred) {
    socket.data.expiryDeferred = true;
    logger.debug('Socket reauth deferred for a pending refresh-auth', ids);
    scheduleSocketReauth(socket, REAUTH_PENDING_OFFER_WAIT_MS);
    return 'deferred';
  }

  if (isSocketVerifierDown() && !pastOutageBound(socket)) {
    // Probe: an expired token verifies to null (or a 4xx) once the verifier is
    // back; a throw means it is still down. Not reported to Sentry per socket:
    // the outage is already reported where it was first seen.
    const token = heldToken(socket);
    let stillDown = false;
    try {
      await resolveSocketSession(token);
    } catch (error) {
      stillDown = !isExpectedClientError(error);
    }
    if (!socket.connected || heldToken(socket) !== token) return 'skipped';
    if (stillDown) {
      logger.warn('Socket kept past token expiry during verifier outage', ids);
      scheduleSocketReauth(socket, REAUTH_RETRY_MS);
      return 'retry';
    }
  }

  requireReauth(socket, 'expired');
  return 'reauth_required';
}

/**
 * Re-check the socket's held token (see the section comment above). Exported
 * for tests.
 */
export async function reverifySocket(socket: GameSocket): Promise<ReverifyOutcome> {
  if (!socket.connected) return 'skipped';

  // Past expiry plus grace the token is dead: no JWKS check or user lookup
  // needed (unless an offer is pending or the verifier is down, see
  // handleExpiredToken). The verify below is for tokens still inside their
  // lifetime (no-exp tokens, deletion and role re-checks).
  if (pastExpiry(socket, REAUTH_GRACE_MS)) {
    return handleExpiredToken(socket);
  }

  // Capture the token before the await: an accepted `refresh-auth` may swap
  // it meanwhile, and a result for the old token must then change nothing.
  const token = heldToken(socket);
  const superseded = (): boolean => !socket.connected || heldToken(socket) !== token;

  let session: SocketSession | null;
  try {
    session = await resolveSocketSession(token);
  } catch (error) {
    if (superseded()) return 'skipped';
    if (isExpectedClientError(error)) {
      requireReauth(socket, pastExpiry(socket) ? 'expired' : 'rejected');
      return 'reauth_required';
    }
    // Same split as authenticateSocket: an outage or defect reaches Sentry,
    // because a timer callback never reaches the Express error chain (#672).
    captureException(error, { flow: 'socket-reauth', socketId: socket.id });
    logger.warn('Socket reauth check failed, retrying', {
      socketId: socket.id,
      userId: socket.data.user?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    scheduleSocketReauth(socket, REAUTH_RETRY_MS);
    return 'retry';
  }

  // The client may have gone, or refreshed, while the check was in flight.
  if (superseded()) return 'skipped';

  if (!session) {
    requireReauth(socket, pastExpiry(socket) ? 'expired' : 'rejected');
    return 'reauth_required';
  }
  if (session.user.id !== socket.data.user?.id) {
    requireReauth(socket, 'user_changed');
    return 'reauth_required';
  }

  await adoptSession(socket, session);
  logger.debug('Socket reauth check passed', { socketId: socket.id, userId: session.user.id });
  return 'kept';
}

export type RefreshAuthResult =
  | { ok: true }
  | {
      ok: false;
      code: 'bad_request' | 'rate_limited' | 'unauthorized' | 'unavailable' | 'superseded';
    };

/**
 * Handle `refresh-auth { token }`: swap the socket onto a fresh token for the
 * same user without reconnecting. A rejected token leaves the socket on its
 * current token and timer; a token for another user ends the connection.
 */
export async function handleRefreshAuth(
  socket: GameSocket,
  payload: unknown
): Promise<RefreshAuthResult> {
  const token =
    payload && typeof payload === 'object' ? (payload as { token?: unknown }).token : undefined;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 'bad_request' };
  }

  // Two offers in flight can finish out of order; only the latest may act.
  // Recorded before the rate limit, so a limited newer offer still stops an
  // older in-flight one from winning.
  socket.data.latestOfferedToken = token;
  const superseded = (): boolean => socket.data.latestOfferedToken !== token;

  // The token the server already holds: nothing to verify or re-check.
  if (token === heldToken(socket)) {
    socket.data.offerPending = false;
    return { ok: true };
  }
  if (!checkRefreshAuthAllowed(socket)) {
    socket.data.offerPending = false;
    return { ok: false, code: 'rate_limited' };
  }
  socket.data.offerPending = true;

  let session: SocketSession | null;
  try {
    session = await resolveSocketSession(token);
  } catch (error) {
    if (superseded()) return { ok: false, code: 'superseded' };
    socket.data.offerPending = false;
    if (isExpectedClientError(error)) {
      return { ok: false, code: 'unauthorized' };
    }
    captureException(error, { flow: 'socket-refresh-auth', socketId: socket.id });
    return { ok: false, code: 'unavailable' };
  }

  if (superseded()) return { ok: false, code: 'superseded' };
  socket.data.offerPending = false;
  if (!socket.connected) return { ok: false, code: 'unauthorized' };

  if (!session) {
    logger.info('Socket refresh-auth rejected', {
      socketId: socket.id,
      userId: socket.data.user?.id,
    });
    return { ok: false, code: 'unauthorized' };
  }
  if (session.user.id !== socket.data.user?.id) {
    requireReauth(socket, 'user_changed');
    return { ok: false, code: 'unauthorized' };
  }

  socket.data.authToken = token;
  await adoptSession(socket, session);
  logger.debug('Socket auth refreshed', { socketId: socket.id, userId: session.user.id });
  return { ok: true };
}

interface JoinGamePayload {
  gameId?: unknown;
}

function extractGameId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const { gameId } = payload as JoinGamePayload;
  return typeof gameId === 'string' && gameId.length > 0 ? gameId : null;
}

/**
 * Build the snapshot payload returned on join / rejoin. Includes the current
 * game row and the most recent events so reconnecting clients can rebuild
 * state without a separate REST call.
 */
export interface GameSnapshot {
  game: {
    id: string;
    teamId: string;
    opponent: string;
    date: Date;
    status: GameStatus;
    homeScore: number;
    awayScore: number;
  };
  events: Array<GameEvent & { player?: UserSummary | null }>;
}

export async function buildGameSnapshot(gameId: string): Promise<GameSnapshot | null> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      events: {
        include: {
          // Same player shape as every REST event payload (#813).
          player: { select: USER_SUMMARY_SELECT },
        },
        orderBy: { timestamp: 'desc' },
        take: SNAPSHOT_EVENT_LIMIT,
      },
    },
  });

  if (!game) return null;

  // Return events in chronological order for client convenience.
  return {
    game: {
      id: game.id,
      teamId: game.teamId,
      opponent: game.opponent,
      date: game.date,
      status: game.status,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
    },
    events: [...game.events].reverse(),
  };
}

/**
 * Whether a user may view a game's live room: the one rule `join-game` and the
 * re-auth room re-check (`pruneGameRooms`) share.
 *
 * All games are currently team-private: only members of the game's team can
 * spectate via Socket.io. The Game model has no `isPublic`/`visibility` field
 * yet. Public spectator mode (open join for any authenticated user) is tracked
 * in issue #48.
 */
export async function canViewGame(
  userId: string,
  gameId: string
): Promise<'allowed' | 'not_found' | 'forbidden'> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: { id: true, teamId: true },
  });
  if (!game) return 'not_found';
  return (await canAccessTeam(userId, game.teamId)) ? 'allowed' : 'forbidden';
}

/**
 * Authorize and join the requesting user into the `game:<gameId>` room.
 * Exposed separately so unit tests can exercise authorization without wiring
 * a full Socket.io server.
 */
export async function handleJoinGame(
  socket: GameSocket,
  payload: unknown
): Promise<
  | { ok: true; gameId: string }
  | { ok: false; code: 'bad_request' | 'not_found' | 'forbidden'; message: string }
> {
  const gameId = extractGameId(payload);
  if (!gameId) {
    return { ok: false, code: 'bad_request', message: 'gameId is required' };
  }

  const verdict = await canViewGame(socket.data.user.id, gameId);
  if (verdict === 'not_found') {
    return { ok: false, code: 'not_found', message: 'Game not found' };
  }
  if (verdict === 'forbidden') {
    return { ok: false, code: 'forbidden', message: 'You do not have access to this game' };
  }

  await socket.join(gameRoom(gameId));

  const snapshot = await buildGameSnapshot(gameId);
  if (snapshot) {
    socket.emit('game-snapshot', snapshot);
  }

  return { ok: true, gameId };
}

/**
 * Wire up connection handlers on the provided Socket.io server. Called once
 * at server startup from `setupWebSocketHandlers`.
 */
export function registerGameEventHandlers(io: SocketServer): void {
  // Rate limits run BEFORE authentication so unauthenticated connect spam
  // never reaches the JWKS/user lookup (audit #16). A rejection here is a
  // `connect_error: Rate limited` on the client, which backs off and retries
  // like `Service unavailable`.
  io.use((socket, next) => {
    const ip = socketClientIp(socket);
    if (!checkHandshakeAllowed(ip) || !hasConcurrentCapacity(ip)) {
      logger.warn('Socket handshake rate limited', { socketId: socket.id, ip });
      next(new Error(RATE_LIMITED_MESSAGE));
      return;
    }
    next();
  });

  io.use((socket, next) => {
    void authenticateSocket(socket as GameSocket, next);
  });

  io.on('connection', (socket: Socket) => {
    const typedSocket = socket as GameSocket;
    const userId = typedSocket.data.user?.id;
    const ip = socketClientIp(socket);
    registerConnection(ip);
    scheduleSocketReauth(typedSocket);
    logger.info('Socket connected', { socketId: socket.id, userId });

    socket.on('join-game', (payload: unknown, ack?: (response: unknown) => void) => {
      // Cheap in-memory check before the two DB queries + 100-event snapshot
      // a join costs (audit #16).
      if (!checkJoinAllowed(socket)) {
        logger.warn('Socket join-game rate limited', { socketId: socket.id, userId });
        if (ack) ack({ success: false, error: 'Too many join attempts — slow down', code: 'rate_limited' });
        return;
      }
      void handleJoinGame(typedSocket, payload).then((result) => {
        if (!result.ok) {
          logger.warn('Socket join-game rejected', {
            socketId: socket.id,
            userId,
            code: result.code,
          });
          if (ack) ack({ success: false, error: result.message, code: result.code });
          return;
        }
        logger.info('Socket joined game room', {
          socketId: socket.id,
          userId,
          gameId: result.gameId,
        });
        if (ack) ack({ success: true, gameId: result.gameId });
      }).catch((error) => {
        logger.error('Socket join-game error', {
          socketId: socket.id,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (ack) ack({ success: false, error: 'Internal error', code: 'internal' });
      });
    });

    socket.on(REFRESH_AUTH_EVENT, (payload: unknown, ack?: (response: unknown) => void) => {
      void handleRefreshAuth(typedSocket, payload)
        .then((result) => {
          if (!ack) return;
          ack(result.ok ? { success: true } : { success: false, code: result.code });
        })
        .catch((error) => {
          logger.error('Socket refresh-auth error', {
            socketId: socket.id,
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (ack) ack({ success: false, code: 'internal' });
        });
    });

    socket.on('leave-game', (payload: unknown, ack?: (response: unknown) => void) => {
      const gameId = extractGameId(payload);
      if (!gameId) {
        if (ack) ack({ success: false, error: 'gameId is required', code: 'bad_request' });
        return;
      }
      void socket.leave(gameRoom(gameId));
      if (ack) ack({ success: true, gameId });
    });

    socket.on('disconnect', (reason: string) => {
      releaseConnection(ip);
      clearSocketReauth(socket.id);
      logger.info('Socket disconnected', { socketId: socket.id, userId, reason });
    });
  });
}
