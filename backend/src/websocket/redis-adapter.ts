/**
 * Socket.io Redis adapter (#452).
 *
 * With `REDIS_SOCKET_ADAPTER_URL` set, `attachRedisAdapter` replaces the
 * in-memory adapter with `@socket.io/redis-adapter`: every `io.to(room).emit`
 * is delivered to this task's sockets and published to Redis, and every other
 * task subscribed to the same Redis delivers it to its own sockets in that
 * room. Unset, nothing changes: the in-memory adapter, one task.
 *
 * TLS and AUTH come from the URL (`rediss://:<token>@host:port`, #755); the
 * publisher uses the same connection options as the shared cache client
 * (`utils/redis.ts#redisClientOptions`).
 *
 * **Degradation (Redis is a best-effort dependency):** the adapter delivers to
 * this task's own sockets before it publishes, so a Redis outage never stops
 * local delivery. While Redis is unreachable a publish fails fast (no offline
 * queue) and is dropped with one `warn` per outage (before the client has
 * connected for the first time, `debug` only); sockets on other tasks miss
 * those broadcasts, and because every broadcast carries the current score
 * their score converges on the next one they receive after Redis recovers
 * (events in between are recovered by the `game-snapshot` on the next join or
 * reconnect). The subscriber queues its subscriptions until it connects and
 * re-subscribes after every reconnect. Neither client ever stops retrying.
 */

import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server as SocketServer } from 'socket.io';
import { redisClientOptions, redisRetryDelay } from '../utils/redis';
import { logger } from '../utils/logger';

export const SOCKET_ADAPTER_URL_ENV = 'REDIS_SOCKET_ADAPTER_URL';

export interface SocketAdapterHandle {
  /** Quit both Redis connections; never rejects. */
  close(): Promise<void>;
}

/**
 * Install the Redis adapter on `io` when `url` is set. Returns `null` (and
 * leaves the in-memory adapter) when it is not.
 */
export function attachRedisAdapter(
  io: SocketServer,
  url: string | undefined = process.env[SOCKET_ADAPTER_URL_ENV]
): SocketAdapterHandle | null {
  if (!url) {
    logger.info('Socket.io adapter: in-memory', { reason: `${SOCKET_ADAPTER_URL_ENV} unset` });
    return null;
  }

  const pubClient = new Redis(url, { ...redisClientOptions(), lazyConnect: false });
  // The subscriber keeps the default offline queue and never gives up on a
  // queued command, so the adapter's (un-awaited) SUBSCRIBE / PSUBSCRIBE wait
  // for the connection instead of rejecting; ioredis re-subscribes on reconnect.
  const subClient = new Redis(url, { retryStrategy: redisRetryDelay, maxRetriesPerRequest: null });

  // Until a client has been ready once, its failures are the boot window
  // (connecting, or a publish before the connection is up): `debug` only.
  // After that, the first failure of an outage is a `warn` and the recovery an
  // `info`, once per outage across both clients.
  const everReady = { pub: false, sub: false };
  let outageLogged = false;
  const logFailure = (client: 'pub' | 'sub', error: unknown): void => {
    const detail = { client, error: error instanceof Error ? error.message : String(error) };
    if (!everReady[client]) {
      logger.debug('Socket.io adapter: Redis not connected yet', detail);
      return;
    }
    if (outageLogged) return;
    outageLogged = true;
    logger.warn('Socket.io adapter: Redis unavailable, delivering to this task only', detail);
  };
  for (const [name, client] of [['pub', pubClient], ['sub', subClient]] as const) {
    client.on('error', (error: unknown) => logFailure(name, error));
    client.on('ready', () => {
      everReady[name] = true;
      if (outageLogged) {
        outageLogged = false;
        logger.info('Socket.io adapter: Redis recovered', { client: name });
      }
    });
  }

  // The adapter does not await `publish`; a rejection (disconnected, timed
  // out) would be unhandled. Drop it: local delivery already happened.
  const publish = pubClient.publish.bind(pubClient);
  pubClient.publish = ((channel: string | Buffer, message: string | Buffer) =>
    publish(channel, message).catch((error: unknown) => {
      logFailure('pub', error);
      return 0;
    })) as Redis['publish'];

  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.io adapter: redis');

  return {
    async close(): Promise<void> {
      // QUIT only on a live connection; one still (re)connecting is dropped,
      // since a queued QUIT would wait for a Redis that may never answer.
      await Promise.allSettled(
        [pubClient, subClient].map((client) =>
          client.status === 'ready' ? client.quit() : Promise.resolve(client.disconnect())
        )
      );
    },
  };
}
