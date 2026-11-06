/**
 * Logging of the Socket.io Redis adapter's clients (#452), with ioredis and the
 * adapter mocked: failures before a client has ever been ready are the boot
 * window (`debug`, never a false `warn`); after it, one `warn` per outage and
 * one `info` on recovery. Delivery across real servers is in
 * tests/integration/socket-redis-adapter.redis.test.ts.
 */
import { EventEmitter } from 'events';

class MockRedis extends EventEmitter {
  status = 'connecting';
  publish: jest.Mock = jest.fn().mockResolvedValue(1);
  /** The original publish, before attachRedisAdapter wraps it. */
  readonly rawPublish = this.publish;
  quit = jest.fn().mockResolvedValue('OK');
  disconnect = jest.fn();
}

const mockClients: MockRedis[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const client = new MockRedis();
    mockClients.push(client);
    return client;
  }),
}));

jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: jest.fn(() => 'redis-adapter'),
}));

import type { Server as SocketServer } from 'socket.io';
import { logger } from '../../src/utils/logger';
import { attachRedisAdapter, type SocketAdapterHandle } from '../../src/websocket/redis-adapter';

const WARN = 'Socket.io adapter: Redis unavailable, delivering to this task only';

describe('attachRedisAdapter', () => {
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;
  let debug: jest.SpyInstance;
  let io: SocketServer;
  let handle: SocketAdapterHandle | null;
  let pub: MockRedis;
  let sub: MockRedis;

  beforeEach(() => {
    mockClients.length = 0;
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    io = { adapter: jest.fn() } as unknown as SocketServer;
    handle = attachRedisAdapter(io, 'redis://example.test:6379');
    [pub, sub] = mockClients;
  });

  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
    debug.mockRestore();
  });

  it('installs the adapter on two clients', () => {
    expect(handle).not.toBeNull();
    expect(mockClients).toHaveLength(2);
    expect(io.adapter as jest.Mock).toHaveBeenCalledWith('redis-adapter');
  });

  it('swallows a failed publish (never an unhandled rejection) and logs it at debug before the first connection', async () => {
    pub.rawPublish.mockRejectedValueOnce(new Error("Stream isn't writeable"));
    await expect(pub.publish('channel', 'message')).resolves.toBe(0);
    sub.emit('error', new Error('connect ECONNREFUSED'));
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      'Socket.io adapter: Redis not connected yet',
      expect.objectContaining({ client: 'pub' })
    );
  });

  it('warns once per outage after a client has been ready, and logs the recovery', async () => {
    pub.emit('ready');
    pub.rawPublish.mockRejectedValueOnce(new Error('Command timed out'));
    await pub.publish('channel', 'message');
    pub.emit('error', new Error('connect ECONNREFUSED'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(WARN, expect.objectContaining({ client: 'pub' }));

    pub.emit('ready');
    expect(info).toHaveBeenCalledWith('Socket.io adapter: Redis recovered', { client: 'pub' });

    pub.emit('error', new Error('read ECONNRESET'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('close quits a ready client and drops one still connecting', async () => {
    pub.status = 'ready';
    await handle?.close();
    expect(pub.quit).toHaveBeenCalled();
    expect(sub.quit).not.toHaveBeenCalled();
    expect(sub.disconnect).toHaveBeenCalled();
  });
});
