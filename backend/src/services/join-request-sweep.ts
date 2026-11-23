/**
 * The join-request sweep (#1075): lapses join requests nobody decided within
 * `JOIN_REQUEST_TTL_DAYS`, on teams whose request list nobody opens.
 *
 * The lazy expiry in `JoinLinkService` (the team's list, the requester's next
 * ask) stays; this is the guarantee behind it, so a child's typed name never
 * sits in the table indefinitely. Both go through the same definition of a
 * lapse (`lapsedWhere` / `lapseData` in `join-link-service.ts`), so they cannot
 * drift; `JoinLinkService.expireLapsedRequests` does the batched write and
 * logs the domain event.
 *
 * Shaped like the socket revocation sweep (`websocket/revocation.ts`): an
 * unref'd interval, one run in flight at most, a stalled run reported once, a
 * database failure logged at warn (the first of a streak also to Sentry) and
 * retried by the next tick, never thrown. The API is single-replica
 * (`utils/replica-guard.ts`), so no lock across tasks is needed; with more
 * than one task each would run the same idempotent UPDATE.
 *
 * Started in `src/index.ts` after the server listens (the first run is
 * `JOIN_REQUEST_SWEEP_FIRST_RUN_MS` later, so it never delays startup and a
 * task replaced by frequent deploys still sweeps); stopped by the shutdown's
 * first step, before Prisma disconnects.
 */

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { JoinLinkService } from './join-link-service';

/** How often the sweep runs: a lapsed request is expired within about this long. */
export const JOIN_REQUEST_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Delay from start to the first run, so a task that lives under an hour still sweeps. */
export const JOIN_REQUEST_SWEEP_FIRST_RUN_MS = 60 * 1000;
/** A sweep still running after this long is reported once as stalled. */
export const JOIN_REQUEST_SWEEP_STALL_MS = 5 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;
let sweepFailing = false;

/** A throw the sweep itself did not expect (not a database failure): log and report it. */
function reportDefect(error: unknown, ids: Record<string, string>): void {
  logger.error('Join request sweep error', {
    ...ids,
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { flow: 'join-request-sweep', ...ids });
}

/**
 * One sweep. Returns how many requests it expired. A database failure expires
 * nothing (logged at warn, the first failure of a streak reported to Sentry)
 * and never throws; the next sweep tries again. `cancelled` is true once the
 * periodic sweep that started this run was stopped (shutdown): a query the
 * shutdown's Prisma disconnect fails is then not reported.
 */
export async function sweepLapsedJoinRequests(cancelled: () => boolean = () => false): Promise<number> {
  let expired: number;
  try {
    expired = await JoinLinkService.expireLapsedRequests();
  } catch (error) {
    if (cancelled()) return 0;
    logger.warn('Join request sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!sweepFailing) captureException(error, { flow: 'join-request-sweep' });
    sweepFailing = true;
    return 0;
  }
  sweepFailing = false;
  return expired;
}

/**
 * Start the periodic sweep (a second call replaces the first). Both timers
 * are unref'd, so they never keep the process alive, and a tick is skipped
 * while the previous sweep is still running. The pool bounds each statement
 * (`models/pool-config.ts`, `statement_timeout`), so a slow batch fails the
 * run and the next tick retries; a run past `JOIN_REQUEST_SWEEP_STALL_MS` is
 * reported, once, at error and to Sentry.
 */
export function startJoinRequestSweep(
  intervalMs = JOIN_REQUEST_SWEEP_INTERVAL_MS,
  firstRunMs = JOIN_REQUEST_SWEEP_FIRST_RUN_MS
): void {
  stopJoinRequestSweep();
  // In-flight state belongs to this timer alone, so a restart never shares
  // or clears another timer's marker.
  let startedAt: number | null = null;
  let stallReported = false;
  const tick = (): void => {
    if (startedAt !== null) {
      const runningMs = Date.now() - startedAt;
      if (runningMs >= JOIN_REQUEST_SWEEP_STALL_MS && !stallReported) {
        stallReported = true;
        reportDefect(new Error('Join request sweep stalled'), { runningMs: String(runningMs) });
      }
      return;
    }
    startedAt = Date.now();
    stallReported = false;
    void sweepLapsedJoinRequests(() => sweepTimer !== timer)
      .catch((error: unknown) => reportDefect(error, {}))
      .finally(() => {
        startedAt = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const first = setTimeout(tick, firstRunMs);
  first.unref();
  sweepTimer = timer;
  firstRunTimer = first;
}

/** Stop the periodic sweep. Safe to call more than once. */
export function stopJoinRequestSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (firstRunTimer) clearTimeout(firstRunTimer);
  sweepTimer = null;
  firstRunTimer = null;
}
