/**
 * WebSocket event handlers
 */

import { Server as SocketServer } from 'socket.io';
import { registerGameEventHandlers } from './game-events';
import { setIo } from './io-registry';

export function setupWebSocketHandlers(io: SocketServer): void {
  setIo(io);
  registerGameEventHandlers(io);
}

export { getIo, setIo } from './io-registry';
export { emitGameEvent, emitGameStatusChange } from './emit';
