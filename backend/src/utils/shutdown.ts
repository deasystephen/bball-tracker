/**
 * Graceful shutdown on SIGTERM / SIGINT (#747, #1052).
 *
 * In ECS, node runs as PID 1 (`docker/entrypoint.sh` execs it, no init), so it
 * receives the task's SIGTERM directly; ECS waits `stopTimeout` (default 30 s,
 * not set in `infra/task-definition.json`) before SIGKILL. The steps, in order:
 *
 *  1. `http`: `io.close()`. Socket.io drops every socket and closes the engine
 *     (each WebSocket gets a close frame, so clients see `transport close` and
 *     auto-reconnect to the new task), then closes the HTTP server, which
 *     settles only once every TCP connection it accepted has closed. No
 *     `disconnect` packet is sent on purpose: a server-initiated disconnect
 *     (`io server disconnect`) is NOT auto-reconnected by socket.io-client, and
 *     live games would stay dark. A connection still open after
 *     SHUTDOWN_HTTP_DRAIN_MS is destroyed (`destroyConnections`), which lets the
 *     close settle (#1052: a peer that never answers the WebSocket close frame
 *     holds it for ws's 30 s close timeout; a connection that has sent no
 *     complete request, or an unhandled Upgrade, holds it until the peer
 *     closes).
 *  2. `ses-consumer`: the SES event consumer stops (its long poll is aborted).
 *  3. `prisma` and `redis` quit in parallel.
 *
 * Every step has its own bound (STEP_TIMEOUT_MS), so one closer that never
 * settles is abandoned and the next still gets its turn. Each step logs
 * `Shutdown step started` and `Shutdown step finished` (`step`, `outcome`,
 * `durationMs`). Exit code: 0 when every step finished, or only `prisma` /
 * `redis` failed to quit (logged at `warn`); 1 when a step timed out, or
 * `http` / `ses-consumer` threw (`Shutdown incomplete`, error level).
 *
 * The bounds add up to less than SHUTDOWN_GRACE_MS. The hard-exit timer
 * (`exit(1)` after SHUTDOWN_GRACE_MS, under the 30 s stop timeout) is the last
 * resort and names the steps still pending. It stays ref'd on purpose: the
 * routine always ends in `exit()`, and an unref'd timer would let a closer
 * that never settles (with no other handle left) drain the event loop and exit
 * 0 with neither line.
 *
 * Collaborators are parameters so the routine is unit-testable without a server.
 */

import { logger } from './logger';

/** Under ECS's default 30 s `stopTimeout`, so the process exits before SIGKILL. */
export const SHUTDOWN_GRACE_MS = 25_000;

/** How long `io.close()` may wait for connections before the rest are destroyed. */
export const SHUTDOWN_HTTP_DRAIN_MS = 10_000;

export type ShutdownStep = 'http' | 'ses-consumer' | 'prisma' | 'redis';

/** Per-step bound; a step still running then is abandoned. */
export const STEP_TIMEOUT_MS: Readonly<Record<ShutdownStep, number>> = {
  http: SHUTDOWN_HTTP_DRAIN_MS + 2_000,
  'ses-consumer': 5_000,
  prisma: 5_000,
  redis: 5_000,
};

type StepOutcome = 'ok' | 'failed' | 'timed-out';

export interface ShutdownDeps {
  /** Closes every socket and the underlying HTTP server. */
  io: { close(): Promise<void> };
  /**
   * Destroys every TCP connection the HTTP server still holds and returns how
   * many there were. Called when `io.close()` has not settled after
   * SHUTDOWN_HTTP_DRAIN_MS.
   */
  destroyConnections?: () => number;
  /** Null when SES_EVENTS_QUEUE_URL is unset. */
  consumer: { stop(): Promise<void> } | null;
  disconnectPrisma: () => Promise<void>;
  closeRedis: () => Promise<void>;
  exit: (code: number) => void;
  graceMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves true when `promise` settles within `ms`, false otherwise; never rejects. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
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

    const pending = new Set<ShutdownStep>();
    // Steps that timed out: their closer may still be running when the grace ends.
    const abandoned: ShutdownStep[] = [];
    const failed: ShutdownStep[] = [];
    const hardExit = setTimeout(() => {
      logger.error('Shutdown grace period elapsed; forcing exit', {
        signal,
        pendingSteps: [...pending],
        abandonedSteps: [...abandoned],
      });
      deps.exit(1);
    }, deps.graceMs ?? SHUTDOWN_GRACE_MS);

    /** Run one closer under its own bound; never rejects. */
    const runStep = async (step: ShutdownStep, close: () => Promise<void>): Promise<StepOutcome> => {
      pending.add(step);
      logger.info('Shutdown step started', { signal, step });
      const startedAt = Date.now();
      let error: string | undefined;
      // `Promise.resolve().then` so a closer that throws synchronously is a rejection too.
      const closing = Promise.resolve()
        .then(close)
        .catch((err: unknown) => {
          error = errorMessage(err);
          throw err;
        });
      const settled = await settlesWithin(closing, STEP_TIMEOUT_MS[step]);
      pending.delete(step);
      const outcome: StepOutcome = !settled ? 'timed-out' : error === undefined ? 'ok' : 'failed';
      const durationMs = Date.now() - startedAt;
      if (outcome === 'ok') {
        logger.info('Shutdown step finished', { signal, step, outcome, durationMs });
      } else {
        logger.warn('Shutdown step finished', {
          signal,
          step,
          outcome,
          durationMs,
          ...(outcome === 'timed-out' ? { timeoutMs: STEP_TIMEOUT_MS[step] } : { error }),
        });
      }
      return outcome;
    };

    // socket.io's close() awaits each namespace adapter's close() before it
    // calls httpServer.close(); destroying connections helps only the latter,
    // so a step still stuck after the destroy points at the adapter.
    const closeHttp = async (): Promise<void> => {
      const closing = deps.io.close();
      if (!(await settlesWithin(closing, SHUTDOWN_HTTP_DRAIN_MS)) && deps.destroyConnections) {
        const count = deps.destroyConnections();
        logger.warn('Shutdown: destroyed connections still open', {
          signal,
          count,
          afterMs: SHUTDOWN_HTTP_DRAIN_MS,
        });
      }
      await closing;
    };

    const record = (step: ShutdownStep, outcome: StepOutcome, failureExits: boolean): void => {
      if (outcome === 'timed-out') abandoned.push(step);
      if (outcome === 'failed' && failureExits) failed.push(step);
    };

    record('http', await runStep('http', closeHttp), true);
    const { consumer } = deps;
    if (consumer) {
      record('ses-consumer', await runStep('ses-consumer', () => consumer.stop()), true);
    }
    // A connection that does not quit cleanly is logged, not an error exit.
    const [prisma, redis] = await Promise.all([
      runStep('prisma', deps.disconnectPrisma),
      runStep('redis', deps.closeRedis),
    ]);
    record('prisma', prisma, false);
    record('redis', redis, false);

    clearTimeout(hardExit);
    if (abandoned.length > 0 || failed.length > 0) {
      logger.error('Shutdown incomplete', { signal, abandonedSteps: abandoned, failedSteps: failed });
      deps.exit(1);
      return;
    }
    logger.info('Shutdown complete', { signal });
    deps.exit(0);
  };
}
