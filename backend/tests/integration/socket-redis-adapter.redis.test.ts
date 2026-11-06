/**
 * Socket.io Redis adapter and shared rate-limit counters against a REAL Redis
 * (#452).
 *
 * Two Socket.io servers in this process, each with its own Redis adapter,
 * stand in for two API tasks: a `game-event` emitted through the production
 * `emitGameEvent` on server A must reach a client connected to server B. The
 * same Redis backs the shared rate-limit counters, which two store instances
 * (two "tasks") must see as one budget.
 *
 * CI provides Redis as a service on the backend test job; locally it is the
 * docker-compose Redis. The URL is REDIS_TEST_URL (default
 * redis://localhost:6379), never REDIS_URL, which tests/setup.ts clears for
 * every other suite. Every key and room carries a per-run id and is removed in
 * afterAll.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import Redis from 'ioredis';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Options } from 'express-rate-limit';
import { attachRedisAdapter, type SocketAdapterHandle } from '../../src/websocket/redis-adapter';
import { emitGameEvent, type GameEventBroadcast } from '../../src/websocket/emit';
import { setIo } from '../../src/websocket/io-registry';
import { gameRoom } from '../../src/websocket/game-events';
import { SharedRateLimitStore } from '../../src/api/middleware/rate-limit-store';
import {
  CONCURRENT_KEY_PREFIX,
  INSTANCE_ID,
  INSTANCE_KEY_PREFIX,
  INSTANCE_TTL_MS,
  MAX_HANDSHAKES_PER_WINDOW,
  checkHandshakeAllowed,
  hasConcurrentCapacity,
  registerConnection,
  releaseConnection,
  resetSocketRateLimits,
} from '../../src/websocket/rate-limit';
import { closeRedis, getReadyRedisClient } from '../../src/utils/redis';
import { logger } from '../../src/utils/logger';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

async function redisReady(): Promise<boolean> {
  return getReadyRedisClient() !== null;
}

jest.setTimeout(20000);

const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
const RUN = randomUUID().slice(0, 8);

interface TestServer {
  http: HttpServer;
  io: SocketServer;
  adapter: SocketAdapterHandle | null;
  url: string;
}

/** A Socket.io server whose clients join the room named in their handshake query. */
async function startServer(adapterUrl: string): Promise<TestServer> {
  const http = createServer();
  const io = new SocketServer(http);
  const adapter = attachRedisAdapter(io, adapterUrl);
  io.on('connection', (socket) => {
    const room = socket.handshake.query.room;
    if (typeof room === 'string') void socket.join(room);
    socket.emit('joined');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return { http, io, adapter, url: `http://127.0.0.1:${port}` };
}

async function stopServer(server: TestServer): Promise<void> {
  await server.io.close();
  await server.adapter?.close();
}

async function connect(server: TestServer, room: string): Promise<ClientSocket> {
  const client = ioClient(server.url, { transports: ['websocket'], forceNew: true, query: { room } });
  await new Promise<void>((resolve, reject) => {
    client.once('joined', () => resolve());
    client.once('connect_error', reject);
  });
  return client;
}

function nextGameEvent(client: ClientSocket, timeoutMs = 5000): Promise<GameEventBroadcast> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no game-event within timeout')), timeoutMs);
    client.once('game-event', (payload: GameEventBroadcast) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function broadcast(gameId: string): GameEventBroadcast {
  return {
    event: { id: randomUUID(), gameId, eventType: 'SHOT' } as unknown as GameEventBroadcast['event'],
    score: { homeScore: 2, awayScore: 0 },
  };
}

/** The adapter's request channel for the default namespace; every adapter subscribes to it. */
const REQUEST_CHANNEL = 'socket.io-request#/#';

async function requestChannelSubscribers(redis: Redis): Promise<number> {
  const reply = (await redis.call('PUBSUB', 'NUMSUB', REQUEST_CHANNEL)) as [string, number];
  return Number(reply[1]);
}

/** Wait until both adapters' subscribers are subscribed (the adapter does not expose readiness). */
async function waitForSubscribers(redis: Redis, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await requestChannelSubscribers(redis)) >= count) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Redis adapter subscribers never subscribed');
}

describe('Socket.io Redis adapter and shared rate limits (real Redis)', () => {
  let redis: Redis;
  const clients: ClientSocket[] = [];
  const servers: TestServer[] = [];
  const keysToDelete = new Set<string>();

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  afterEach(async () => {
    setIo(null);
    for (const client of clients.splice(0)) client.disconnect();
    for (const server of servers.splice(0)) await stopServer(server);
  });

  afterAll(async () => {
    if (keysToDelete.size > 0) await redis.del(...keysToDelete);
    const leftovers = await redis.keys(`rl:${RUN}-*`);
    if (leftovers.length > 0) await redis.del(...leftovers);
    await redis.quit();
    resetSocketRateLimits();
    await closeRedis();
    process.env.REDIS_URL = '';
  });

  describe('adapter', () => {
    it('delivers a game-event emitted on one server to a client on the other', async () => {
      const before = await requestChannelSubscribers(redis);
      const a = await startServer(REDIS_URL);
      const b = await startServer(REDIS_URL);
      servers.push(a, b);
      await waitForSubscribers(redis, before + 2);

      const gameId = `${RUN}-game`;
      const onA = await connect(a, gameRoom(gameId));
      const onB = await connect(b, gameRoom(gameId));
      const otherGameOnB = await connect(b, gameRoom(`${RUN}-other`));
      clients.push(onA, onB, otherGameOnB);

      let leaked = false;
      otherGameOnB.on('game-event', () => {
        leaked = true;
      });

      const payload = broadcast(gameId);
      const receivedA = nextGameEvent(onA);
      const receivedB = nextGameEvent(onB);
      setIo(a.io);
      emitGameEvent(gameId, payload);

      await expect(receivedA).resolves.toEqual(payload);
      await expect(receivedB).resolves.toEqual(payload);
      // Room scoping survives the hop: the other game's client got nothing.
      await new Promise((r) => setTimeout(r, 200));
      expect(leaked).toBe(false);
    });

    it('leaves the in-memory adapter when no URL is configured', () => {
      // Never attached to an HTTP server, so there is nothing to close.
      const io = new SocketServer();
      const before = io.of('/').adapter;
      expect(attachRedisAdapter(io, undefined)).toBeNull();
      expect(io.of('/').adapter).toBe(before);
    });

    it('closes during a reconnect without unhandled rejections from queued (un)subscribes', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        // Port 1: the subscriber never connects, so the adapter's SUBSCRIBE and
        // PSUBSCRIBE sit in its offline queue and io.close() queues the
        // UNSUBSCRIBEs behind them; closing must settle all of them quietly.
        const server = await startServer('redis://127.0.0.1:1');
        await new Promise((r) => setTimeout(r, 300));
        await stopServer(server);
        await new Promise((r) => setTimeout(r, 300));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('still delivers to its own clients when Redis is unreachable, without crashing', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      const warn = jest.spyOn(logger, 'warn');
      try {
        // Port 1: nothing listens, every connect is refused.
        const server = await startServer('redis://127.0.0.1:1');
        servers.push(server);
        const gameId = `${RUN}-down`;
        const local = await connect(server, gameRoom(gameId));
        clients.push(local);

        const payload = broadcast(gameId);
        const received = nextGameEvent(local);
        setIo(server.io);
        emitGameEvent(gameId, payload);
        await expect(received).resolves.toEqual(payload);

        // Let the failed publish settle.
        await new Promise((r) => setTimeout(r, 200));
        expect(unhandled).not.toHaveBeenCalled();
        // Never connected: the boot window logs at debug, not a false warn.
        expect(warn).not.toHaveBeenCalledWith(
          'Socket.io adapter: Redis unavailable, delivering to this task only',
          expect.anything()
        );
      } finally {
        process.off('unhandledRejection', unhandled);
        warn.mockRestore();
      }
    });
  });

  describe('shared counters', () => {
    beforeAll(() => {
      process.env.REDIS_URL = REDIS_URL;
    });

    it('two express-rate-limit stores with the same name share one budget', async () => {
      const options = { windowMs: 60_000 } as Options;
      const taskA = new SharedRateLimitStore(`${RUN}-api`);
      const taskB = new SharedRateLimitStore(`${RUN}-api`);
      const otherLimiter = new SharedRateLimitStore(`${RUN}-auth`);
      for (const store of [taskA, taskB, otherLimiter]) store.init(options);

      // The first command on the lazily connecting client may fall back to
      // memory; wait until Redis answers.
      for (let i = 0; i < 50 && Number(await redis.exists(`rl:${RUN}-api:warmup`)) === 0; i++) {
        await taskA.increment('warmup');
        await new Promise((r) => setTimeout(r, 100));
      }

      const key = '203.0.113.9';
      expect((await taskA.increment(key)).totalHits).toBe(1);
      expect((await taskB.increment(key)).totalHits).toBe(2);
      expect((await taskA.increment(key)).totalHits).toBe(3);
      // A different limiter keyed on the same IP has its own counter.
      expect((await otherLimiter.increment(key)).totalHits).toBe(1);
      expect(Number(await redis.get(`rl:${RUN}-api:${key}`))).toBe(3);
      expect(await redis.pttl(`rl:${RUN}-api:${key}`)).toBeGreaterThan(0);

      for (const store of [taskA, taskB, otherLimiter]) store.shutdown();
    });

    it('two API tasks behind one limiter config answer 429 on the shared budget', async () => {
      const name = `${RUN}-mw`;
      const task = (): express.Express => {
        const app = express();
        app.use(rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false, store: new SharedRateLimitStore(name), passOnStoreError: true }));
        app.get('/', (_req, res) => {
          res.json({ ok: true });
        });
        return app;
      };
      const [taskA, taskB] = [task(), task()];
      // Let the shared client finish connecting (the first hits may count in memory).
      for (let i = 0; i < 50 && !(await redisReady()); i++) await new Promise((r) => setTimeout(r, 100));

      const statuses: number[] = [];
      for (const app of [taskA, taskB, taskA, taskB]) {
        statuses.push((await request(app).get('/')).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it('counts socket handshakes in Redis, so a fresh task sees the same window', async () => {
      const ip = `${RUN}-hs`;
      keysToDelete.add(`rl:ws-hs:${ip}`);
      for (let i = 0; i < MAX_HANDSHAKES_PER_WINDOW; i++) {
        expect(await checkHandshakeAllowed(ip)).toBe(true);
      }
      // Forget this task's local window: only the shared counter remains.
      resetSocketRateLimits();
      expect(await checkHandshakeAllowed(ip)).toBe(false);
      expect(await redis.pttl(`rl:ws-hs:${ip}`)).toBeGreaterThan(0);
    });

    it('sums live other tasks plus this task, drops a dead task and ignores its own stale field', async () => {
      const ip = `${RUN}-conc`;
      const hash = `${CONCURRENT_KEY_PREFIX}${ip}`;
      keysToDelete.add(hash);
      keysToDelete.add(`${INSTANCE_KEY_PREFIX}${INSTANCE_ID}`);
      const liveOther = `${RUN}-live-task`;
      keysToDelete.add(`${INSTANCE_KEY_PREFIX}${liveOther}`);

      await registerConnection(ip);
      await registerConnection(ip);
      expect(await redis.hget(hash, INSTANCE_ID)).toBe('2');

      // Another live task holds 47 sockets from the same IP: 49 in all, one slot left.
      await redis.set(`${INSTANCE_KEY_PREFIX}${liveOther}`, '1', 'PX', 60_000);
      await redis.hset(hash, liveOther, '47');
      // A crashed task (no liveness key) left 100 behind; they must not count.
      await redis.hset(hash, `${RUN}-dead-task`, '100');
      // A stale, inflated field for THIS task (a lost write) is ignored: this
      // task counts itself from memory, and its next write corrects the field.
      await redis.hset(hash, INSTANCE_ID, '500');

      expect(await hasConcurrentCapacity(ip)).toBe(true);
      expect(await redis.hexists(hash, `${RUN}-dead-task`)).toBe(0);
      await registerConnection(ip);
      expect(await redis.hget(hash, INSTANCE_ID)).toBe('3');
      expect(await hasConcurrentCapacity(ip)).toBe(false);

      await releaseConnection(ip);
      expect(await hasConcurrentCapacity(ip)).toBe(true);
      await releaseConnection(ip);
      await releaseConnection(ip);
      // The last release deletes the field; a release past zero leaves it gone.
      expect(await redis.hexists(hash, INSTANCE_ID)).toBe(0);
      await releaseConnection(ip);
      expect(await redis.hexists(hash, INSTANCE_ID)).toBe(0);
      expect(await redis.pttl(hash)).toBeLessThanOrEqual(INSTANCE_TTL_MS);
    });
  });
});
