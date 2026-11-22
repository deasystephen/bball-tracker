/**
 * #1052, against a real HTTP server, Socket.io and raw TCP peers that never
 * close their side (allowHalfOpen), the way a proxy can hold a connection:
 * the connections that kept `io.close()` from settling, and the two fixes.
 */
import { createServer, type Server as HttpServer } from 'http';
import { connect, type Socket } from 'net';
import type { AddressInfo } from 'net';
import { Server as SocketServer } from 'socket.io';
import { refuseUnhandledUpgrades, trackConnections } from '../../src/utils/http-connections';

const UPGRADE_OTHER_PATH =
  'GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
  'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
const UPGRADE_H2C =
  'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\n' +
  'HTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n';

let httpServer: HttpServer;
let io: SocketServer;
const peers: Socket[] = [];

function listen(): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as AddressInfo).port));
  });
}

/** A peer that writes `payload` and never closes its own side. */
function peer(port: number, payload: string): Promise<{ socket: Socket; received: () => string; ended: Promise<void> }> {
  return new Promise((resolve) => {
    let data = '';
    const socket = connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => {
      if (payload) socket.write(payload);
      resolve({ socket, received: () => data, ended });
    });
    // The server's FIN; the peer keeps its own side open regardless.
    const ended = new Promise<void>((r) => socket.once('end', () => r()));
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('error', () => undefined);
    peers.push(socket);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); }),
  ]);
  clearTimeout(timer);
  return result;
}

beforeEach(() => {
  httpServer = createServer((_req, res) => res.end('ok'));
  io = new SocketServer(httpServer);
});

afterEach(async () => {
  for (const socket of peers.splice(0)) socket.destroy();
  if (httpServer.listening) {
    httpServer.closeAllConnections();
    await new Promise((r) => httpServer.close(() => r(undefined)));
  }
});

describe('the stuck closer (#1052)', () => {
  it('reproduces it: an Upgrade for a path engine.io does not own keeps io.close() from settling', async () => {
    const tracker = trackConnections(httpServer);
    const port = await listen();
    const p = await peer(port, UPGRADE_OTHER_PATH);
    // engine.io sends its bare FIN after 1 s; the socket is still counted after it.
    await p.ended;
    await sleep(200);
    expect(tracker.size()).toBe(1);

    const closing = io.close();
    expect(await settlesWithin(closing, 1_000)).toBe(false);

    // The shutdown routine's fallback after its drain period.
    expect(tracker.destroyAll()).toBe(1);
    expect(await settlesWithin(closing, 5_000)).toBe(true);
  });

  it('reproduces it: a connection with no complete request is never reaped once close() has begun', async () => {
    const tracker = trackConnections(httpServer);
    const port = await listen();
    await peer(port, 'GET / HTTP/1.1\r\nHost: x\r\n');
    await sleep(50);

    const closing = io.close();
    expect(await settlesWithin(closing, 1_000)).toBe(false);
    expect(tracker.destroyAll()).toBe(1);
    expect(await settlesWithin(closing, 5_000)).toBe(true);
  });
});

describe('refuseUnhandledUpgrades', () => {
  it.each([
    ['a WebSocket upgrade on another path', UPGRADE_OTHER_PATH],
    ['an h2c upgrade', UPGRADE_H2C],
  ])('answers %s with 400 and closes the socket, so io.close() settles', async (_label, payload) => {
    refuseUnhandledUpgrades(httpServer, `${io.path()}/`);
    const tracker = trackConnections(httpServer);
    const port = await listen();
    const p = await peer(port, payload);

    await p.ended;
    expect(p.received()).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    // Closed on the server side although the peer never closed its own.
    await sleep(50);
    expect(tracker.size()).toBe(0);
    expect(await settlesWithin(io.close(), 5_000)).toBe(true);
  });

  it('leaves Socket.io upgrades to engine.io', async () => {
    refuseUnhandledUpgrades(httpServer, `${io.path()}/`);
    const port = await listen();
    const connected = new Promise<void>((r) => io.on('connection', () => r()));
    const { io: ioClient } = await import('socket.io-client');
    const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    try {
      expect(await settlesWithin(connected, 5_000)).toBe(true);
    } finally {
      client.close();
    }
  });
});

describe('trackConnections', () => {
  it('forgets a connection once it closes', async () => {
    const tracker = trackConnections(httpServer);
    const port = await listen();
    const p = await peer(port, '');
    await sleep(50);
    expect(tracker.size()).toBe(1);
    p.socket.destroy();
    await sleep(50);
    expect(tracker.size()).toBe(0);
    expect(tracker.destroyAll()).toBe(0);
  });
});
