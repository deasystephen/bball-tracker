/**
 * Local delivery through the REAL `@socket.io/redis-adapter` when publishing
 * fails (#452). The adapter publishes before it delivers locally, so a
 * `publish` that throws synchronously would abort the broadcast; the wrapper
 * in `attachRedisAdapter` must keep local delivery working. ioredis is faked
 * (no Redis needed); socket.io, the adapter and the client are real.
 */
import { EventEmitter } from 'events';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';

class FakeRedis extends EventEmitter {
  status = 'ready';
  publish: jest.Mock = jest.fn(() => {
    throw new Error('synchronous publish failure');
  });
  subscribe = jest.fn().mockResolvedValue(1);
  psubscribe = jest.fn().mockResolvedValue(1);
  unsubscribe = jest.fn().mockResolvedValue(1);
  punsubscribe = jest.fn().mockResolvedValue(1);
  quit = jest.fn().mockResolvedValue('OK');
  disconnect = jest.fn();
}

const mockFakes: FakeRedis[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const fake = new FakeRedis();
    mockFakes.push(fake);
    return fake;
  }),
}));

import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { logger } from '../../src/utils/logger';
import { attachRedisAdapter, type SocketAdapterHandle } from '../../src/websocket/redis-adapter';

describe('Redis adapter local delivery when publish throws synchronously', () => {
  let http: HttpServer;
  let io: SocketServer;
  let handle: SocketAdapterHandle | null;
  let client: ClientSocket;
  let debug: jest.SpyInstance;

  beforeAll(async () => {
    debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    http = createServer();
    io = new SocketServer(http);
    handle = attachRedisAdapter(io, 'redis://example.test:6379');
    io.on('connection', (socket) => {
      void socket.join('game:local');
      socket.emit('joined');
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve) => client.once('joined', () => resolve()));
  });

  afterAll(async () => {
    client.disconnect();
    await io.close();
    await handle?.close();
    debug.mockRestore();
  });

  it('still delivers to this task\'s sockets', async () => {
    const received = new Promise<unknown>((resolve) => client.once('game-event', resolve));
    expect(() => io.to('game:local').emit('game-event', { ok: true })).not.toThrow();
    await expect(received).resolves.toEqual({ ok: true });
    expect(debug).toHaveBeenCalledWith(
      'Socket.io adapter: Redis not connected yet',
      expect.objectContaining({ client: 'pub', error: 'synchronous publish failure' })
    );
  });
});
