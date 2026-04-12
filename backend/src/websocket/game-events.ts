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
 *  - Socket.io's built-in ping/pong handles heartbeats. Clients that reconnect
 *    must re-emit `join-game` to resubscribe; they will receive a fresh
 *    `game-snapshot`.
 *
 * Target concurrency
 *  - 50 concurrent spectators per game on a single ECS task is the GA target.
 *    For higher fan-out, add the `@socket.io/redis-adapter` (out of scope
 *    for this change; see issue #26).
 */

import type { Server as SocketServer, Socket } from 'socket.io';
import type { GameEvent, GameStatus } from '@prisma/client';
import prisma from '../models';
import { canAccessTeam } from '../utils/permissions';
import { WorkOSService } from '../services/workos-service';
import { logger } from '../utils/logger';

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
}

// We intentionally keep the event-map generics at their default (untyped) and
// only parameterize `SocketData`. Typing the full event maps provides little
// value here (event names are string literals at the call site) and would
// force `socket.emit` to reject dynamic payloads.
export type GameSocket = Socket & { data: GameSocketData };

export function gameRoom(gameId: string): string {
  return `${GAME_ROOM_PREFIX}${gameId}`;
}

/**
 * Resolve a bearer-style token to a local user. Mirrors the logic in
 * `src/api/auth/middleware.ts` but returns a plain value instead of mutating
 * an Express request. Returns `null` when the token is invalid/expired or the
 * user does not exist.
 */
export async function resolveSocketUser(
  rawToken: string | undefined
): Promise<AuthenticatedSocketUser | null> {
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

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, email: true, name: true, role: true },
      });
      return user ?? null;
    } catch {
      return null;
    }
  }

  const workosUser = await WorkOSService.verifyToken(token);
  if (!workosUser) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { workosUserId: workosUser.id },
    select: { id: true, email: true, name: true, role: true },
  });
  return user ?? null;
}

/**
 * Socket.io connection authentication middleware. Runs once per socket during
 * the handshake.
 */
export async function authenticateSocket(
  socket: GameSocket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const authPayload = socket.handshake.auth as { token?: string } | undefined;
    const headerToken = socket.handshake.headers.authorization;
    const token = authPayload?.token ?? headerToken;

    const user = await resolveSocketUser(token);
    if (!user) {
      next(new Error('Unauthorized'));
      return;
    }

    socket.data.user = user;
    next();
  } catch (error) {
    logger.error('Socket authentication failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(new Error('Unauthorized'));
  }
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
  events: Array<GameEvent & { player?: { id: string; name: string } | null }>;
}

export async function buildGameSnapshot(gameId: string): Promise<GameSnapshot | null> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      events: {
        include: {
          player: { select: { id: true, name: true } },
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
  io.use((socket, next) => {
    void authenticateSocket(socket as GameSocket, next);
  });

  io.on('connection', (socket: Socket) => {
    const typedSocket = socket as GameSocket;
    const userId = typedSocket.data.user?.id;
    logger.info('Socket connected', { socketId: socket.id, userId });

    socket.on('join-game', (payload: unknown, ack?: (response: unknown) => void) => {
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
      logger.info('Socket disconnected', { socketId: socket.id, userId, reason });
    });
  });
}
