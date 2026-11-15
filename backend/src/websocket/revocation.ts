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
 *    `convertToManaged` (and `refuseUnderage`) call
 *    `io-registry.ts#revokeUserSockets(userId)` after their transaction
 *    commits; the API registered `revokeLocalUserSockets` there, which walks
 *    this process's sockets and needs no Redis or database. The services
 *    import only the leaf `io-registry`, never this socket graph. In an
 *    operator script (`scripts/data-subject-request.ts`,
 *    `scripts/convert-to-managed.ts`) no Socket.io server is registered, so it
 *    does nothing there.
 * 2. The sweep, the guarantee. Every `REVOCATION_SWEEP_INTERVAL_MS` the API
 *    reads, in one query, the rows of the distinct users holding a socket on
 *    this process and cuts every socket whose row fails `sessionRevoked`: row
 *    gone (erased), tombstoned (`deletedAt`), no longer carrying the WorkOS id
 *    the socket's token was verified for (conversion, deletion), or refused by
 *    the handshake's gate (`socketUserAllowed`). This covers the operator scripts,
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
import { AUTH_USER_SELECT } from '../api/auth/middleware';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { setUserSocketRevoker } from './io-registry';
import { requireReauth, socketUserAllowed, type GameSocket } from './game-events';

/** How often the API re-reads the rows behind its open sockets. */
export const REVOCATION_SWEEP_INTERVAL_MS = 10 * 1000;
/** User ids per sweep query; more open users than this take more than one. */
export const REVOCATION_SWEEP_CHUNK = 1000;
/**
 * A sweep still running after this long no longer blocks the next one, so a
 * query that never settles (a half-open connection) cannot stop the sweep
 * for the life of the process.
 */
export const REVOCATION_SWEEP_STALL_MS = 60 * 1000;

/**
 * The columns the sweep reads: the handshake's (`AUTH_USER_SELECT`, so a
 * column added for a gate reaches the sweep too) plus the WorkOS id.
 */
export const SOCKET_REVOCATION_SELECT = {
  ...AUTH_USER_SELECT,
  workosUserId: true,
} satisfies Prisma.UserSelect;

export type SocketRevocationRow = Prisma.UserGetPayload<{ select: typeof SOCKET_REVOCATION_SELECT }>;

/**
 * A connected, authenticated socket whose transport is still open. A socket
 * already being cut (`requireReauth` closed its transport, the `disconnect`
 * event has not fired yet) is excluded, so it is never cut twice.
 */
function isLive(socket: GameSocket): boolean {
  return socket.connected && socket.conn.readyState === 'open' && Boolean(socket.data.user?.id);
}

/** This process's live sockets (local even with the Redis adapter on). */
function localSockets(io: SocketServer): GameSocket[] {
  return ([...io.of('/').sockets.values()] as GameSocket[]).filter(isLive);
}

/**
 * True when the socket's session no longer stands: `row` is the user's live
 * row (`deletedAt: null`), or undefined when there is none. The WorkOS id the
 * token was verified for must still be on the row; a dev-token socket (null)
 * is checked on the row and the handshake's gate only, and a socket with no
 * recorded value (undefined: a path that forgot to set it) fails closed.
 */
export function sessionRevoked(socket: GameSocket, row: SocketRevocationRow | undefined): boolean {
  if (!row) return true;
  const verifiedFor = socket.data.workosUserId;
  if (verifiedFor === undefined) return true;
  if (verifiedFor !== null && row.workosUserId !== verifiedFor) return true;
  return !socketUserAllowed(row);
}

/**
 * Close every live socket `io` holds for `userId` (the in-process path, run
 * through `io-registry.ts#revokeUserSockets`). Returns how many were closed.
 * Never throws: a failure here must not fail the deletion that called it, and
 * the sweep closes what it missed.
 */
export function revokeLocalUserSockets(io: SocketServer, userId: string): number {
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
/** When the sweep in flight started, or null when none is. */
let sweepStartedAt: number | null = null;
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
    // A socket that left or was cut, or whose user was swapped, while the
    // query ran is judged by the next sweep, not on a row read for someone else.
    if (!isLive(socket) || !queried.has(socket.data.user.id)) continue;
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
 * Install both paths for `io`: register `revokeLocalUserSockets` as the
 * in-process revoker and start the periodic sweep. Called once by
 * `setupWebSocketHandlers`; a second call replaces the first.
 */
export function installSocketRevocation(io: SocketServer): void {
  setUserSocketRevoker(revokeLocalUserSockets);
  startRevocationSweep(io);
}

/**
 * Start the periodic sweep for `io` (a second call replaces the first). The
 * timer is unref'd, so it never keeps the process alive. A tick is skipped
 * while the previous sweep runs, unless that one has been running for
 * `REVOCATION_SWEEP_STALL_MS`.
 */
export function startRevocationSweep(io: SocketServer, intervalMs = REVOCATION_SWEEP_INTERVAL_MS): void {
  stopRevocationSweep();
  sweepTimer = setInterval(() => {
    const now = Date.now();
    if (sweepStartedAt !== null) {
      if (now - sweepStartedAt < REVOCATION_SWEEP_STALL_MS) return;
      logger.warn('Socket revocation sweep stalled; starting another', {
        stalledMs: now - sweepStartedAt,
      });
    }
    const startedAt = now;
    sweepStartedAt = startedAt;
    void sweepRevokedSockets(io)
      .catch((error: unknown) => {
        logger.warn('Socket revocation sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        // A stalled sweep that settles late must not clear a newer one's mark.
        if (sweepStartedAt === startedAt) sweepStartedAt = null;
      });
  }, intervalMs);
  sweepTimer.unref();
}

/** Stop the periodic sweep. Safe to call more than once. */
export function stopRevocationSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepStartedAt = null;
}
