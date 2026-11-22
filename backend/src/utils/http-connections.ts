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
 * `trackConnections` covers all three at shutdown: `destroyIdle()` destroys
 * every connection still open that is not serving a request
 * (`utils/shutdown.ts`, after its drain period).
 */

import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { Duplex } from 'stream';

export interface DestroyResult {
  /** Connections destroyed: none was serving an HTTP request. */
  destroyed: number;
  /** Connections left alone because a request on them is still running. */
  inFlight: number;
}

export interface ConnectionTracker {
  /** Connections currently open. */
  size(): number;
  /**
   * Destroy every open connection that is not serving an HTTP request (an
   * upgraded or refused-upgrade socket, an idle or half-sent connection). A
   * request still running keeps its connection, so shutdown never cuts a
   * response off mid-write; the step bound covers a request that never ends.
   */
  destroyIdle(): DestroyResult;
}

export function trackConnections(server: Server): ConnectionTracker {
  const open = new Set<Duplex>();
  // Requests running per connection: a count, because a pipelined request
  // can start before the previous response on the same socket has closed.
  const busy = new Map<Duplex, number>();
  server.on('connection', (socket: Duplex) => {
    open.add(socket);
    socket.once('close', () => {
      open.delete(socket);
      busy.delete(socket);
    });
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const { socket } = req;
    busy.set(socket, (busy.get(socket) ?? 0) + 1);
    res.once('close', () => {
      const left = (busy.get(socket) ?? 1) - 1;
      if (left > 0) busy.set(socket, left);
      else busy.delete(socket);
    });
  });
  return {
    size: () => open.size,
    destroyIdle: () => {
      let destroyed = 0;
      for (const socket of open) {
        if (busy.has(socket)) continue;
        socket.destroy();
        open.delete(socket);
        destroyed += 1;
      }
      return { destroyed, inFlight: open.size };
    },
  };
}

/** Backstop for a peer that never reads the 400 (so the write never finishes). */
export const REFUSED_UPGRADE_DESTROY_MS = 2_000;

const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Answer every Upgrade request whose URL does not start with `enginePathBase`
 * with a 400, and destroy the socket once the answer is written. Pass
 * Socket.io's `io.path()`: the trailing slash is dropped, so this is never
 * stricter than engine.io's own prefix match (with or without
 * `addTrailingSlash`); anything engine.io might handle is left to it.
 */
export function refuseUnhandledUpgrades(server: Server, enginePathBase: string): void {
  const base = enginePathBase.replace(/\/+$/, '');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if ((req.url ?? '').startsWith(base)) return;
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
