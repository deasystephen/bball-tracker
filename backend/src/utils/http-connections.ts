/**
 * TCP connection hygiene for the API's HTTP server (#1052).
 *
 * `server.close()` (which `io.close()` awaits on shutdown) settles only once
 * every connection the server accepted has closed. Node closes idle keep-alive
 * connections itself, but not:
 *
 *  - a socket handed to an `upgrade` listener. engine.io answers an Upgrade
 *    request for a path it does not own (`/ws`, `Upgrade: h2c`, scanner probes)
 *    with `socket.end()` after 1 s: a FIN, with no timer behind it. The server
 *    socket is half-open, so if the peer never closes its side the socket stays
 *    for the life of the process, and `server.close()` waits on it forever.
 *    Reproduced locally; whether the ALB leaves such a connection open is not
 *    known. `refuseUnhandledUpgrades` answers 400 and destroys the socket once
 *    the answer is flushed, or after REFUSED_UPGRADE_DESTROY_MS if the peer
 *    does not read it.
 *  - a connection that has sent no complete request when `close()` is called:
 *    `close()` stops the timer that enforces `headersTimeout`, so nothing
 *    reaps it until the peer closes;
 *  - a WebSocket whose peer does not answer the close frame: ws waits 30 s
 *    (its `closeTimeout`) before destroying it, past the shutdown grace.
 *
 * `trackConnections` covers all three at shutdown: `destroyAll()` destroys
 * whatever is still open (`utils/shutdown.ts`, after its drain period).
 */

import type { Server } from 'http';
import type { Duplex } from 'stream';

export interface ConnectionTracker {
  /** Connections currently open. */
  size(): number;
  /** Destroy every open connection; returns how many there were. */
  destroyAll(): number;
}

export function trackConnections(server: Server): ConnectionTracker {
  const open = new Set<Duplex>();
  server.on('connection', (socket: Duplex) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  });
  return {
    size: () => open.size,
    destroyAll: () => {
      const count = open.size;
      for (const socket of open) socket.destroy();
      open.clear();
      return count;
    },
  };
}

/** Backstop for a peer that never reads the 400 (so the write never finishes). */
export const REFUSED_UPGRADE_DESTROY_MS = 2_000;

const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Answer every Upgrade request outside `enginePath` with a 400 and destroy the
 * socket once the answer is written. `enginePath` is Socket.io's `io.path()`
 * plus a trailing slash, matched as engine.io matches it (a prefix of the raw
 * URL), so engine.io keeps every upgrade it would handle.
 */
export function refuseUnhandledUpgrades(server: Server, enginePath: string): void {
  server.on('upgrade', (req: { url?: string }, socket: Duplex) => {
    if ((req.url ?? '').startsWith(enginePath)) return;
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    socket.on('error', () => socket.destroy());
    const backstop = setTimeout(() => socket.destroy(), REFUSED_UPGRADE_DESTROY_MS);
    backstop.unref();
    socket.once('close', () => clearTimeout(backstop));
    socket.end(BAD_REQUEST, () => socket.destroy());
  });
}
