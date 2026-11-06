/**
 * Periodic sweep of unreferenced avatar uploads (#957).
 *
 * `POST /uploads/avatar-url` presigns an upload to the public avatars bucket;
 * the object exists as soon as the upload finishes, before any profile write
 * stores its URL. A cancelled edit, a failed `PATCH /auth/me` or an abandoned
 * Add Player leaves an object nothing references. This sweep deletes objects
 * under `avatars/` that are older than `AVATAR_SWEEP_MIN_AGE_MS` and that no
 * `User.profilePictureUrl` references.
 *
 * Safety:
 *   - Each chunk of the listing is read before the references it is checked
 *     against, so references are at least as fresh as the list. A failed
 *     read ends the run; nothing more is deleted.
 *   - Only keys of the exact issued shape `avatars/<id>/<file>` are candidates.
 *   - The 7-day age floor covers a photo picked, then saved after a long
 *     background pause (the presign itself is valid 5 min).
 *   - Memory is bounded: pages are filtered as they arrive.
 *   - Reference matching is over-inclusive (`referencedAvatarKeys`).
 *   - At most `MAX_DELETES_PER_RUN` objects go per run, so a logic error can
 *     never empty the unversioned bucket in one pass.
 *
 * Off unless `AVATAR_SWEEP_ENABLED=true` (same shape as the SES consumer,
 * which is null until its queue URL is set): it needs `s3:ListBucket` on the
 * bucket, which the task role must be granted first. The API is single-replica
 * and runs are serialized (the next is scheduled when one finishes).
 */

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
  deleteAvatarKeys,
  isDeletableAge,
  listAvatarObjectPages,
  loadReferencedAvatarKeys,
} from './upload-service';

/** Objects younger than this are never swept. */
export const AVATAR_SWEEP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Gap between the end of one run and the start of the next. */
export const AVATAR_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** First run after boot: well clear of the deploy overlap. */
export const AVATAR_SWEEP_FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
/** Ceiling on deletions in one run; the rest wait for the next run. */
export const MAX_DELETES_PER_RUN = 1000;

export interface AvatarSweepResult {
  listed: number;
  candidates: number;
  referenced: number;
  deleted: number;
  failed: number;
  capped: boolean;
}

/** Candidates gathered before each reference check and delete. */
const SWEEP_CHUNK = 1000;

/**
 * One sweep. Pages through `avatars/`, keeping only old issued keys, and
 * every `SWEEP_CHUNK` candidates reads references (after that chunk was
 * listed) and deletes the unreferenced ones, so memory holds at most a chunk
 * plus the reference set, never the bucket. Stops once
 * `MAX_DELETES_PER_RUN` deletes were attempted or the signal fires. Throws
 * when a listing page or a reference read fails; nothing more is deleted.
 */
export async function sweepOrphanedAvatars(
  now: Date = new Date(),
  signal?: AbortSignal
): Promise<AvatarSweepResult> {
  const cutoff = now.getTime() - AVATAR_SWEEP_MIN_AGE_MS;
  const result: AvatarSweepResult = {
    listed: 0,
    candidates: 0,
    referenced: 0,
    deleted: 0,
    failed: 0,
    capped: false,
  };
  let pending: string[] = [];

  /** Check and delete the pending chunk; false when the run must stop. */
  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const referenced = await loadReferencedAvatarKeys('avatars/');
    const orphans = pending.filter((key) => !referenced.has(key));
    result.referenced += pending.length - orphans.length;
    pending = [];
    const room = MAX_DELETES_PER_RUN - result.deleted - result.failed;
    if (orphans.length > room) result.capped = true;
    const { deleted, failed, aborted } = await deleteAvatarKeys(orphans.slice(0, room), signal);
    result.deleted += deleted;
    result.failed += failed;
    return !aborted && !result.capped;
  };

  let keepGoing = true;
  for await (const page of listAvatarObjectPages('avatars/', { signal })) {
    result.listed += page.length;
    for (const object of page) {
      if (isDeletableAge(object, cutoff)) {
        pending.push(object.key);
        result.candidates += 1;
      }
    }
    if (pending.length >= SWEEP_CHUNK) {
      keepGoing = await flush();
      if (!keepGoing) break;
    }
  }
  if (keepGoing) {
    await flush();
  }

  logger.info('Avatar sweep finished', { ...result });
  return result;
}

type Timer = ReturnType<typeof setTimeout>;

export interface AvatarSweeperOptions {
  intervalMs?: number;
  firstRunDelayMs?: number;
  /** Injected by tests. */
  sweep?: (now: Date, signal: AbortSignal) => Promise<AvatarSweepResult>;
}

export class AvatarSweeper {
  private readonly intervalMs: number;
  private readonly firstRunDelayMs: number;
  private readonly sweep: (now: Date, signal: AbortSignal) => Promise<AvatarSweepResult>;
  private timer: Timer | null = null;
  private abortController: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;

  constructor(options: AvatarSweeperOptions = {}) {
    this.intervalMs = options.intervalMs ?? AVATAR_SWEEP_INTERVAL_MS;
    this.firstRunDelayMs = options.firstRunDelayMs ?? AVATAR_SWEEP_FIRST_RUN_DELAY_MS;
    this.sweep = options.sweep ?? sweepOrphanedAvatars;
  }

  get isRunning(): boolean {
    return this.abortController !== null;
  }

  /** Schedule the first run. A second call while running is a no-op. */
  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();
    this.schedule(this.firstRunDelayMs);
    logger.info('Avatar sweeper started');
  }

  /** Cancel the next run and wait for an in-flight one to unwind. */
  async stop(): Promise<void> {
    const controller = this.abortController;
    if (!controller) return;
    this.abortController = null;
    controller.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    logger.info('Avatar sweeper stopped');
  }

  /** Run one sweep now; failures are logged, never thrown. */
  async runOnce(): Promise<void> {
    const signal = this.abortController?.signal ?? new AbortController().signal;
    try {
      await this.sweep(new Date(), signal);
      this.consecutiveFailures = 0;
      if (signal.aborted) logger.info('Avatar sweep stopped');
    } catch (error) {
      // Shutdown aborted an in-flight call: a normal stop, not a failure.
      if (signal.aborted) {
        logger.info('Avatar sweep stopped');
        return;
      }
      this.consecutiveFailures += 1;
      logger.error('Avatar sweep failed; nothing more deleted this run', {
        operation: 'avatar-sweep',
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures: this.consecutiveFailures,
      });
      // One report per outage, not one per run.
      if (this.consecutiveFailures === 1) {
        captureException(error, { flow: 'avatar-sweep' });
      }
    }
  }

  private schedule(delayMs: number): void {
    // The loop this timer belongs to. A stop() then start() while a run is in
    // flight creates a new controller; the old run must not re-arm, or two
    // loops would sweep side by side.
    const owner = this.abortController;
    const timer = setTimeout(() => {
      this.timer = null;
      const run = this.runOnce().then(() => {
        if (this.inFlight === run) this.inFlight = null;
        if (owner !== null && this.abortController === owner) this.schedule(this.intervalMs);
      });
      this.inFlight = run;
    }, delayMs);
    // Never keep the process alive just to wait for the next sweep.
    timer.unref?.();
    this.timer = timer;
  }
}

/** The sweeper, or `null` unless `AVATAR_SWEEP_ENABLED` is `true`. */
export function createAvatarSweeper(env: NodeJS.ProcessEnv = process.env): AvatarSweeper | null {
  if (env.AVATAR_SWEEP_ENABLED?.trim().toLowerCase() !== 'true') return null;
  return new AvatarSweeper();
}
