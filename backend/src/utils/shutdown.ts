/**
 * Graceful shutdown on SIGTERM / SIGINT (#747).
 *
 * In ECS, node runs as PID 1 (`docker/entrypoint.sh` execs it, no init), so it
 * receives the task's SIGTERM directly; ECS waits `stopTimeout` (default 30 s,
 * not set in `infra/task-definition.json`) before SIGKILL. The sequence:
 *
 *  1. `io.close()`: Socket.io drops every socket and closes the engine (each
 *     WebSocket gets a close frame, so clients see `transport close` and
 *     auto-reconnect to the new task), then closes the HTTP server so it stops
 *     accepting connections. No `disconnect` packet is sent on purpose: a
 *     server-initiated disconnect (`io server disconnect`) is NOT
 *     auto-reconnected by socket.io-client, and live games would stay dark.
 *  2. The SES event consumer stops (its in-flight long poll unwinds).
 *  3. Prisma and Redis quit, in parallel; a failure in either is logged at
 *     `warn` and does not change the exit code.
 *  4. `exit(0)`.
 *
 * A hard-exit timer (`exit(1)` after SHUTDOWN_GRACE_MS, under the 30 s stop
 * timeout) guarantees the process ends even if a closer hangs. It stays ref'd
 * on purpose: the routine always ends in `exit()`, and an unref'd timer would
 * let a closer that never settles (with no other handle left) drain the event
 * loop and exit 0 with neither `Shutdown complete` nor the forced `exit(1)`.
 *
 * Collaborators are parameters so the routine is unit-testable without a server.
 */

import { logger } from './logger';

/** Under ECS's default 30 s `stopTimeout`, so the process exits before SIGKILL. */
export const SHUTDOWN_GRACE_MS = 25_000;

export interface ShutdownDeps {
  /** Closes every socket and the underlying HTTP server. */
  io: { close(): Promise<void> };
  /** Null when SES_EVENTS_QUEUE_URL is unset. */
  consumer: { stop(): Promise<void> } | null;
  disconnectPrisma: () => Promise<void>;
  closeRedis: () => Promise<void>;
  exit: (code: number) => void;
  graceMs?: number;
}

/**
 * Build the shutdown routine. The returned function runs the sequence once; a
 * second signal while it is running is ignored.
 */
export function createShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals) => Promise<void> {
  let started = false;
  return async (signal: NodeJS.Signals): Promise<void> => {
    if (started) return;
    started = true;
    logger.info('Shutting down', { signal });

    const hardExit = setTimeout(() => {
      logger.error('Shutdown grace period elapsed; forcing exit', { signal });
      deps.exit(1);
    }, deps.graceMs ?? SHUTDOWN_GRACE_MS);

    try {
      await deps.io.close();
      await deps.consumer?.stop();
      const quits = await Promise.allSettled([deps.disconnectPrisma(), deps.closeRedis()]);
      const names = ['prisma', 'redis'] as const;
      quits.forEach((result, i) => {
        if (result.status === 'rejected') {
          logger.warn('Shutdown: connection did not quit cleanly', {
            signal,
            // Not `client`: that key is the app build on request lines (#963).
            connection: names[i],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    } catch (err) {
      logger.error('Shutdown step failed', {
        signal,
        error: err instanceof Error ? err.message : String(err),
      });
      clearTimeout(hardExit);
      deps.exit(1);
      return;
    }
    clearTimeout(hardExit);
    logger.info('Shutdown complete', { signal });
    deps.exit(0);
  };
}
