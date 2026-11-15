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
/** A sweep still running after this long is reported once as stalled. */
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

interface SocketIdentity {
  userId: string;
  workosUserId: string | null | undefined;
}

function identityOf(socket: GameSocket): SocketIdentity {
  return { userId: socket.data.user.id, workosUserId: socket.data.workosUserId };
}

function sameIdentity(a: SocketIdentity | undefined, b: SocketIdentity): boolean {
  return a !== undefined && a.userId === b.userId && a.workosUserId === b.workosUserId;
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
  let closed = 0;
  try {
    for (const socket of localSockets(io)) {
      if (socket.data.user.id === userId && cut(socket)) closed += 1;
    }
  } catch (error) {
    reportDefect(error, { userId });
  }
  // Each cut logs its own `Socket reauth required` line (reason `revoked`).
  return closed;
}

/** Sockets whose cut already failed and was reported: retried, not re-reported. */
const failedCuts = new WeakSet<GameSocket>();

/**
 * Cut one socket; false if that threw. One socket's failure never stops the
 * others being cut; the next sweep retries it, reporting it only the first time.
 */
function cut(socket: GameSocket): boolean {
  try {
    requireReauth(socket, 'revoked');
    return true;
  } catch (error) {
    if (!failedCuts.has(socket)) {
      failedCuts.add(socket);
      reportDefect(error, { socketId: socket.id, userId: socket.data.user?.id });
    }
    return false;
  }
}

/** A throw outside the database read is a defect, not an outage: log and report it. */
function reportDefect(error: unknown, ids: Record<string, string | undefined>): void {
  logger.error('Socket revocation error', {
    ...ids,
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { flow: 'socket-revocation', ...ids });
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepFailing = false;

/**
 * One sweep (see the module comment). Returns how many sockets it closed.
 * A database failure keeps every socket (logged, first failure of a streak
 * reported to Sentry); the next sweep tries again. `cancelled` is true once
 * the periodic sweep that started this run was stopped (shutdown): a query
 * the shutdown's Prisma disconnect fails is then not reported.
 */
export async function sweepRevokedSockets(
  io: SocketServer,
  cancelled: () => boolean = () => false
): Promise<number> {
  const sockets = localSockets(io);
  if (sockets.length === 0) return 0;
  // What each socket was when the rows were read: a socket that changed user
  // or WorkOS identity (an adopted refresh-auth) meanwhile is judged by the
  // next sweep, never against a row read before the change.
  const before = new Map(sockets.map((socket) => [socket, identityOf(socket)]));
  const userIds = [...new Set(sockets.map((socket) => socket.data.user.id))];

  const chunks: SocketRevocationRow[][] = [];
  try {
    for (let i = 0; i < userIds.length; i += REVOCATION_SWEEP_CHUNK) {
      chunks.push(
        await prisma.user.findMany({
          where: { id: { in: userIds.slice(i, i + REVOCATION_SWEEP_CHUNK) }, deletedAt: null },
          select: SOCKET_REVOCATION_SELECT,
        })
      );
    }
  } catch (error) {
    if (cancelled()) return 0;
    logger.warn('Socket revocation sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!sweepFailing) captureException(error, { flow: 'socket-revocation-sweep' });
    sweepFailing = true;
    return 0;
  }
  if (cancelled()) return 0;
  sweepFailing = false;
  const rows = new Map(chunks.flat().map((row) => [row.id, row]));

  let closed = 0;
  for (const socket of sockets) {
    // A socket that left or was cut (by the in-process path, say) while the
    // query ran, or whose identity changed, is left to the next sweep.
    if (!isLive(socket)) continue;
    if (!sameIdentity(before.get(socket), identityOf(socket))) continue;
    if (sessionRevoked(socket, rows.get(socket.data.user.id)) && cut(socket)) closed += 1;
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
 * timer is unref'd, so it never keeps the process alive, and a tick is
 * skipped while the previous sweep is still running: one query in flight at
 * most. A query that never settles would stop the sweep with it (the pool has
 * no statement timeout, a hazard every REST request shares; the expiry
 * re-check in `game-events.ts` still bounds such a socket), so a sweep running
 * past `REVOCATION_SWEEP_STALL_MS` is reported, once, at error and to Sentry.
 */
export function startRevocationSweep(io: SocketServer, intervalMs = REVOCATION_SWEEP_INTERVAL_MS): void {
  stopRevocationSweep();
  // In-flight state belongs to this timer alone, so a restart never shares
  // or clears another timer's marker.
  let startedAt: number | null = null;
  let stallReported = false;
  const timer = setInterval(() => {
    if (startedAt !== null) {
      const runningMs = Date.now() - startedAt;
      if (runningMs >= REVOCATION_SWEEP_STALL_MS && !stallReported) {
        stallReported = true;
        reportDefect(new Error('Socket revocation sweep stalled'), { runningMs: String(runningMs) });
      }
      return;
    }
    startedAt = Date.now();
    stallReported = false;
    void sweepRevokedSockets(io, () => sweepTimer !== timer)
      .catch((error: unknown) => reportDefect(error, {}))
      .finally(() => {
        startedAt = null;
      });
  }, intervalMs);
  timer.unref();
  sweepTimer = timer;
}

/** Stop the periodic sweep. Safe to call more than once. */
export function stopRevocationSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
