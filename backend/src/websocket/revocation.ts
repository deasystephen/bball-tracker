/**
 * Closing the sockets of an account that was deleted or converted to a managed
 * record while connected (#1004).
 *
 * A socket keeps the user it authenticated with until its token is re-checked
 * (`game-events.ts`, "Mid-session re-verification"), which can be minutes
 * away. Two paths close it sooner, both with `reauth_required` and a transport
 * close (`requireReauth`), so the client reconnects, its handshake is refused
 * and its refresh fails:
 *
 * 1. In-process, immediate. `AccountService.deleteAccount` and
 *    `convertToManaged` call `revokeUserSockets(userId)` after their
 *    transaction commits. It walks this process's sockets and needs no
 *    Redis or database. In an operator script (`scripts/data-subject-request.ts`,
 *    `scripts/convert-to-managed.ts`) no Socket.io server is registered, so it
 *    does nothing there.
 * 2. The sweep, the guarantee. Every `REVOCATION_SWEEP_INTERVAL_MS` the API
 *    reads, in one query, the rows of the distinct users holding a socket on
 *    this process and cuts every socket whose row fails `sessionRevoked`: row
 *    gone (erased), tombstoned (`deletedAt`), no longer carrying the WorkOS id
 *    the socket's token was verified for (conversion, deletion), or refused by
 *    the age gate the handshake applies. This covers the operator scripts,
 *    which run in another process, and any race the in-process call misses
 *    (a handshake that read the row just before the commit). It depends only
 *    on the database, never on Redis, so its bound holds when Redis is down.
 *
 * Both act only on this process's sockets (`io.of('/').sockets`, local even
 * with the Redis adapter on), so with several tasks each task sweeps its own
 * and no cross-task signal is needed. Nothing here runs per broadcast.
 */

import type { Prisma } from '@prisma/client';
import type { Server as SocketServer } from 'socket.io';
import prisma from '../models';
import { isAgeConfirmed } from '../api/auth/middleware';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getIo } from './io-registry';
import { requireReauth, type GameSocket } from './game-events';

/** How often the API re-reads the rows behind its open sockets. */
export const REVOCATION_SWEEP_INTERVAL_MS = 10 * 1000;
/** User ids per sweep query; more open users than this take more than one. */
export const REVOCATION_SWEEP_CHUNK = 1000;

/** The columns `sessionRevoked` reads. */
export const SOCKET_REVOCATION_SELECT = {
  id: true,
  workosUserId: true,
  ageConfirmedAt: true,
  ageRefusedAt: true,
} satisfies Prisma.UserSelect;

export type SocketRevocationRow = Prisma.UserGetPayload<{ select: typeof SOCKET_REVOCATION_SELECT }>;

/** This process's connected, authenticated sockets. */
function localSockets(io: SocketServer): GameSocket[] {
  return [...io.of('/').sockets.values()].filter(
    (socket) => socket.connected && Boolean((socket as GameSocket).data.user?.id)
  ) as GameSocket[];
}

/**
 * True when the socket's session no longer stands: `row` is the user's live
 * row (`deletedAt: null`), or undefined when there is none. A dev-token
 * socket (`workosUserId` null) is checked on the row and the age gate only.
 */
export function sessionRevoked(socket: GameSocket, row: SocketRevocationRow | undefined): boolean {
  if (!row) return true;
  const verifiedFor = socket.data.workosUserId ?? null;
  if (verifiedFor !== null && row.workosUserId !== verifiedFor) return true;
  return !isAgeConfirmed(row);
}

/**
 * Close every socket this process holds for `userId` (in-process path).
 * Returns how many were closed. Never throws: a failure here must not fail
 * the deletion that called it, and the sweep closes what it missed.
 */
export function revokeUserSockets(userId: string): number {
  const io = getIo();
  if (!io) return 0;
  try {
    const sockets = localSockets(io).filter((socket) => socket.data.user.id === userId);
    for (const socket of sockets) requireReauth(socket, 'revoked');
    if (sockets.length > 0) {
      logger.info('Socket sessions revoked', { userId, count: sockets.length });
    }
    return sockets.length;
  } catch (error) {
    logger.warn('Socket revocation failed; the sweep will close them', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;
let sweepFailing = false;

/**
 * One sweep (see the module comment). Returns how many sockets it closed.
 * A database failure keeps every socket (logged, first failure of a streak
 * reported to Sentry); the next sweep tries again.
 */
export async function sweepRevokedSockets(io: SocketServer): Promise<number> {
  const sockets = localSockets(io);
  if (sockets.length === 0) return 0;
  const queried = new Set(sockets.map((socket) => socket.data.user.id));
  const userIds = [...queried];

  const rows = new Map<string, SocketRevocationRow>();
  try {
    for (let i = 0; i < userIds.length; i += REVOCATION_SWEEP_CHUNK) {
      const found = await prisma.user.findMany({
        where: { id: { in: userIds.slice(i, i + REVOCATION_SWEEP_CHUNK) }, deletedAt: null },
        select: SOCKET_REVOCATION_SELECT,
      });
      for (const row of found) rows.set(row.id, row);
    }
  } catch (error) {
    logger.warn('Socket revocation sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!sweepFailing) captureException(error, { flow: 'socket-revocation-sweep' });
    sweepFailing = true;
    return 0;
  }
  sweepFailing = false;

  let closed = 0;
  for (const socket of sockets) {
    // A socket that left, or whose user was swapped, while the query ran is
    // judged by the next sweep, not on a row read for someone else.
    if (!socket.connected || !queried.has(socket.data.user?.id)) continue;
    if (sessionRevoked(socket, rows.get(socket.data.user.id))) {
      requireReauth(socket, 'revoked');
      closed += 1;
    }
  }
  if (closed > 0) {
    logger.info('Socket revocation sweep closed sockets', { count: closed });
  }
  return closed;
}

/**
 * Start the periodic sweep for `io` (once per process; a second call replaces
 * the first). The timer is unref'd, so it never keeps the process alive, and
 * runs are never overlapped.
 */
export function startRevocationSweep(io: SocketServer, intervalMs = REVOCATION_SWEEP_INTERVAL_MS): void {
  stopRevocationSweep();
  sweepTimer = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void sweepRevokedSockets(io)
      .catch((error: unknown) => {
        logger.warn('Socket revocation sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        sweepRunning = false;
      });
  }, intervalMs);
  sweepTimer.unref();
}

/** Stop the periodic sweep. Safe to call more than once. */
export function stopRevocationSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
