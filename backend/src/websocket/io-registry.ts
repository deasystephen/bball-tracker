/**
 * Registry for the Socket.io server instance.
 *
 * Services that produce real-time events (e.g., game events, status changes)
 * import the current server via `getIo()`. The HTTP bootstrap in `src/index.ts`
 * registers the instance with `setIo()`. Tests can register a test server the
 * same way. `getIo()` returns `null` when no server has been registered, which
 * lets service code no-op when running outside the Socket.io-enabled runtime.
 */

import type { Server as SocketServer } from 'socket.io';

let ioInstance: SocketServer | null = null;

export function setIo(io: SocketServer | null): void {
  ioInstance = io;
}

export function getIo(): SocketServer | null {
  return ioInstance;
}

/**
 * Closes every socket this process holds for a user; returns how many. The
 * API registers `revocation.ts#revokeLocalUserSockets` at startup (#1004).
 * Kept here, in a leaf module, so services can call `revokeUserSockets`
 * without importing the socket handler graph.
 */
export type UserSocketRevoker = (io: SocketServer, userId: string) => number;

let userSocketRevoker: UserSocketRevoker | null = null;

export function setUserSocketRevoker(revoker: UserSocketRevoker | null): void {
  userSocketRevoker = revoker;
}

/**
 * Close this process's live sockets for `userId` with `reauth_required`
 * (#1004). A no-op returning 0 where no Socket.io server or revoker is
 * registered: the operator scripts, where the API's revocation sweep closes
 * them instead. The registered revoker never throws.
 */
export function revokeUserSockets(userId: string): number {
  const io = ioInstance;
  if (!io || !userSocketRevoker) return 0;
  return userSocketRevoker(io, userId);
}
