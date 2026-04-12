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
