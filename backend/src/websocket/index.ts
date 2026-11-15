/**
 * WebSocket event handlers
 */

import { Server as SocketServer } from 'socket.io';
import { registerGameEventHandlers } from './game-events';
import { setIo } from './io-registry';
import { installSocketRevocation } from './revocation';

export function setupWebSocketHandlers(io: SocketServer): void {
  setIo(io);
  registerGameEventHandlers(io);
  // Closes the sockets of deleted or converted accounts (#1004).
  installSocketRevocation(io);
}

export { getIo, setIo } from './io-registry';
export { emitGameEvent, emitGameStatusChange } from './emit';
