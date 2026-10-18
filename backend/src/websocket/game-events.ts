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
 *  - Server re-verifies the handshake token when it expires (at most every
 *    15 minutes); on failure it emits `reauth_required` and closes the
 *    transport, and the client reconnects with a fresh token (#49).
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
import type { GameEvent, GameStatus } from '@prisma/client';
import prisma from '../models';
import { canAccessTeam } from '../utils/permissions';
import { JWT_CLOCK_TOLERANCE_SECONDS, WorkOSService } from '../services/workos-service';
import { logger } from '../utils/logger';
import { USER_SUMMARY_SELECT, type UserSummary } from '../utils/user-select';
import { captureException, isExpectedClientError } from '../utils/sentry';
import {
  RATE_LIMITED_MESSAGE,
  checkHandshakeAllowed,
  checkJoinAllowed,
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
  /** Epoch ms at which the handshake token expires; null when it carries no `exp`. */
  tokenExpiresAt: number | null;
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
}

/**
 * Resolve a bearer-style token to a local user and the token's expiry. Mirrors
 * the logic in `src/api/auth/middleware.ts` but returns a plain value instead
 * of mutating an Express request. Returns `null` when the token is
 * invalid/expired or the user does not exist or is a tombstone (`deletedAt`
 * set).
 */
export async function resolveSocketSession(
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
      ) as { userId?: string; exp?: number };

      if (!decoded.userId || !decoded.exp || decoded.exp < Date.now()) {
        return null;
      }

      // Dev tokens resolve by id, so a deleted account (#444) must be refused
      // explicitly, as the REST middleware does (#667).
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, deletedAt: null },
        select: { id: true, email: true, name: true, role: true },
      });
      // Dev token `exp` is epoch milliseconds.
      return user ? { user, expiresAt: decoded.exp } : null;
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
  // A WorkOS `exp` is epoch seconds.
  return user ? { user, expiresAt: workosUser.expiresAt * 1000 } : null;
}

/** `resolveSocketSession` without the expiry: the user, or null. */
export async function resolveSocketUser(
  rawToken: string | undefined
): Promise<AuthenticatedSocketUser | null> {
  const session = await resolveSocketSession(rawToken);
  return session?.user ?? null;
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
    next();
  } catch (error) {
    logger.error('Socket authentication failed', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // A rejected token returns null from resolveSocketUser and never throws, so
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
// The handshake token is checked once at connect, and a socket keeps its
// handshake for life, so without this an access token that expires mid-game
// would stay authorized until the client disconnected. Each connected socket
// gets one timer, due when its token expires (plus the verifier's clock-skew
// tolerance, so the re-check really fails) and never more than
// REAUTH_MAX_INTERVAL_MS away. When it fires the handshake token is re-run
// through `resolveSocketSession`:
//   - still valid (no `exp`, or a long-lived dev token) → keep the socket,
//     refresh `socket.data`, schedule the next check;
//   - rejected (expired, revoked, account deleted) → emit `reauth_required`
//     and close the underlying Engine.IO connection (`socket.conn.close()`).
//     Not `socket.disconnect()`: with or without `true` it sends a namespace
//     DISCONNECT packet, which socket.io-client reports as `io server
//     disconnect` and never auto-reconnects from, stranding every client
//     built before this change. A transport close is `transport close` on the
//     client, so socket.io auto-reconnects; a client that ignores the event
//     then gets `connect_error: Unauthorized`, refreshes and connects again. Every reconnect re-joins its rooms through `join-game`, which
//     re-runs `canAccessTeam`, so a user removed from a team is evicted within
//     one token lifetime (audit #72);
//   - the verifier throws (JWKS or database outage) → if the token is already
//     past its expiry, it is rejected as above; otherwise check again after
//     REAUTH_RETRY_MS, so an outage never cuts off a valid session.
// Timers live in process memory, like rooms and rate-limit counters (the API
// is single-replica), and are cleared on disconnect.
// ---------------------------------------------------------------------------

/** Server → client event sent just before a re-auth disconnect. */
export const REAUTH_REQUIRED_EVENT = 'reauth_required';
/** Wait this long past `exp`: the verifier accepts a token for its clock tolerance. */
export const REAUTH_GRACE_MS = (JWT_CLOCK_TOLERANCE_SECONDS + 5) * 1000;
/** Upper bound between checks, and the interval for a token without `exp`. */
export const REAUTH_MAX_INTERVAL_MS = 15 * 60 * 1000;
/** Re-check delay after the verifier threw on a token that has not expired. */
export const REAUTH_RETRY_MS = 60 * 1000;

const reauthTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Delay until a socket's next re-verification. */
export function reauthDelayMs(expiresAt: number | null, now: number = Date.now()): number {
  if (expiresAt === null || !Number.isFinite(expiresAt)) {
    return REAUTH_MAX_INTERVAL_MS;
  }
  return Math.min(Math.max(expiresAt - now, 0) + REAUTH_GRACE_MS, REAUTH_MAX_INTERVAL_MS);
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
  const delay = delayMs ?? reauthDelayMs(socket.data.tokenExpiresAt ?? null);
  const timer = setTimeout(() => {
    reauthTimers.delete(socket.id);
    void reverifySocket(socket);
  }, delay);
  // Never keep the process alive for a re-check.
  timer.unref();
  reauthTimers.set(socket.id, timer);
}

function requireReauth(socket: GameSocket): void {
  logger.info('Socket reauth required', {
    socketId: socket.id,
    userId: socket.data.user?.id,
  });
  socket.emit(REAUTH_REQUIRED_EVENT, {});
  // Engine.IO flushes the queued event before it closes the transport.
  socket.conn.close();
}

export type ReverifyOutcome = 'kept' | 'reauth_required' | 'retry' | 'skipped';

/**
 * Re-run the handshake token through `resolveSocketSession` and act on the
 * result (see the section comment above). Exported for tests.
 */
export async function reverifySocket(socket: GameSocket): Promise<ReverifyOutcome> {
  if (!socket.connected) return 'skipped';

  let session: SocketSession | null;
  try {
    session = await resolveSocketSession(handshakeToken(socket));
  } catch (error) {
    if (!socket.connected) return 'skipped';
    const expiresAt = socket.data.tokenExpiresAt ?? null;
    if (expiresAt !== null && expiresAt + REAUTH_GRACE_MS <= Date.now()) {
      requireReauth(socket);
      return 'reauth_required';
    }
    logger.warn('Socket reauth check failed, retrying', {
      socketId: socket.id,
      userId: socket.data.user?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    scheduleSocketReauth(socket, REAUTH_RETRY_MS);
    return 'retry';
  }

  // The client may have gone while the check was in flight.
  if (!socket.connected) return 'skipped';

  if (!session || session.user.id !== socket.data.user?.id) {
    requireReauth(socket);
    return 'reauth_required';
  }

  socket.data.user = session.user;
  socket.data.tokenExpiresAt = session.expiresAt;
  scheduleSocketReauth(socket);
  return 'kept';
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

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: { id: true, teamId: true },
  });
  if (!game) {
    return { ok: false, code: 'not_found', message: 'Game not found' };
  }

  // All games are currently team-private: only members of the game's team can
  // spectate via Socket.io. The Game model has no `isPublic`/`visibility`
  // field yet. Public spectator mode (open join for any authenticated user)
  // is tracked in issue #48.
  const user = socket.data.user;
  const hasAccess = await canAccessTeam(user.id, game.teamId);
  if (!hasAccess) {
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
