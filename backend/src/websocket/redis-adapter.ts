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
 * queue) and is dropped; sockets on other tasks miss those broadcasts, and
 * because every broadcast carries the current score their score converges on
 * the next one they receive after Redis recovers (events in between are
 * recovered by the `game-snapshot` on the next join or reconnect). The
 * subscriber queues its subscriptions until it connects and re-subscribes
 * after every reconnect. Neither client ever stops retrying. Logging is per
 * client: `debug` during the boot window, one `warn` if a client is still not
 * connected `ADAPTER_BOOT_GRACE_MS` after boot, then one `warn` per outage and
 * one `info` when that client recovers.
 */

import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server as SocketServer } from 'socket.io';
import { redisClientOptions, redisRetryDelay } from '../utils/redis';
import { logger } from '../utils/logger';
import { SOCKET_ADAPTER_URL_ENV_VAR } from '../utils/replica-guard';

/** How long after boot a client that has never connected earns one `warn`. */
export const ADAPTER_BOOT_GRACE_MS = 30_000;

export interface SocketAdapterHandle {
  /** Quit both Redis connections; never rejects. */
  close(): Promise<void>;
}

export interface AttachRedisAdapterOptions {
  /** Defaults to `ADAPTER_BOOT_GRACE_MS`; injectable for tests. */
  bootGraceMs?: number;
}

type ClientName = 'pub' | 'sub';

/** The subscriber commands the adapter sends without awaiting them. */
const SUBSCRIBER_COMMANDS = ['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe'] as const;

/**
 * Install the Redis adapter on `io` when `url` is set. Returns `null` (and
 * leaves the in-memory adapter) when it is not.
 */
export function attachRedisAdapter(
  io: SocketServer,
  url: string | undefined = process.env[SOCKET_ADAPTER_URL_ENV_VAR],
  options: AttachRedisAdapterOptions = {}
): SocketAdapterHandle | null {
  if (!url) {
    logger.info('Socket.io adapter: in-memory', { reason: `${SOCKET_ADAPTER_URL_ENV_VAR} unset` });
    return null;
  }

  const pubClient = new Redis(url, { ...redisClientOptions(), lazyConnect: false });
  // The subscriber keeps the default offline queue and never gives up on a
  // queued command, so the adapter's (un-awaited) SUBSCRIBE / PSUBSCRIBE wait
  // for the connection instead of rejecting; ioredis re-subscribes on reconnect.
  const subClient = new Redis(url, { retryStrategy: redisRetryDelay, maxRetriesPerRequest: null });
  const clients: Record<ClientName, Redis> = { pub: pubClient, sub: subClient };

  // Logging, per client (#452 review): until a client has been ready once, its
  // failures are the boot window and log at `debug`; if it is still not ready
  // `bootGraceMs` after boot, one `warn` says so (a wrong URL must not stay
  // invisible). After that, each client's first failure of an outage is a
  // `warn`, and only that client's recovery logs the `info`.
  const everReady: Record<ClientName, boolean> = { pub: false, sub: false };
  const outage: Record<ClientName, boolean> = { pub: false, sub: false };

  const logFailure = (client: ClientName, error: unknown): void => {
    const detail = { client, error: error instanceof Error ? error.message : String(error) };
    if (!everReady[client]) {
      logger.debug('Socket.io adapter: Redis not connected yet', detail);
      return;
    }
    if (outage[client]) return;
    outage[client] = true;
    logger.warn('Socket.io adapter: Redis unavailable, delivering to this task only', detail);
  };

  const bootTimer = setTimeout(() => {
    for (const name of ['pub', 'sub'] as const) {
      if (everReady[name]) continue;
      outage[name] = true;
      logger.warn('Socket.io adapter: Redis not reachable since boot, delivering to this task only', {
        client: name,
        status: clients[name].status,
        graceMs: options.bootGraceMs ?? ADAPTER_BOOT_GRACE_MS,
      });
    }
  }, options.bootGraceMs ?? ADAPTER_BOOT_GRACE_MS);
  bootTimer.unref();

  for (const name of ['pub', 'sub'] as const) {
    const client = clients[name];
    client.on('error', (error: unknown) => logFailure(name, error));
    client.on('ready', () => {
      everReady[name] = true;
      if (outage[name]) {
        outage[name] = false;
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

  // Nor does it await (P)SUBSCRIBE (at attach) or (P)UNSUBSCRIBE (on
  // `io.close()`). Those wait in the subscriber's offline queue while it is not
  // connected, and closing the connection flushes the queue with an error, so
  // each gets a handler: closing during a reconnect must never surface an
  // unhandled rejection.
  for (const command of SUBSCRIBER_COMMANDS) {
    const original = (subClient[command] as (...args: unknown[]) => Promise<unknown>).bind(subClient);
    (subClient as unknown as Record<string, unknown>)[command] = (...args: unknown[]): Promise<unknown> =>
      original(...args).catch((error: unknown) => {
        logger.debug('Socket.io adapter: subscriber command dropped', {
          command,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
  }

  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.io adapter: redis');

  return {
    async close(): Promise<void> {
      clearTimeout(bootTimer);
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
