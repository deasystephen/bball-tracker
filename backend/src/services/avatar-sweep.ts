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
 *   - The bucket listing comes first and the reference set is read after it,
 *     so references are at least as fresh as the list. Either read failing
 *     ends the run with nothing deleted.
 *   - Only keys of the exact issued shape `avatars/<id>/<file>` are candidates.
 *   - The 24 h age floor leaves an in-flight upload (presign valid 5 min) far
 *     more time than the client needs to save its URL.
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
  isIssuedAvatarKey,
  listAvatarObjects,
  loadReferencedAvatarKeys,
} from './upload-service';

/** Objects younger than this are never swept. */
export const AVATAR_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
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

/**
 * One sweep. Throws when the listing or the reference query fails, in which
 * case nothing has been deleted.
 */
export async function sweepOrphanedAvatars(
  now: Date = new Date(),
  signal?: AbortSignal
): Promise<AvatarSweepResult> {
  const objects = await listAvatarObjects('avatars/', { signal });
  const cutoff = now.getTime() - AVATAR_SWEEP_MIN_AGE_MS;
  const candidates = objects
    .filter((o) => isIssuedAvatarKey(o.key) && o.lastModified !== undefined && o.lastModified.getTime() <= cutoff)
    .map((o) => o.key);

  const result: AvatarSweepResult = {
    listed: objects.length,
    candidates: candidates.length,
    referenced: 0,
    deleted: 0,
    failed: 0,
    capped: false,
  };
  if (candidates.length === 0) {
    logger.info('Avatar sweep finished', { ...result });
    return result;
  }

  const referencedKeys = await loadReferencedAvatarKeys('avatars/');
  const orphans = candidates.filter((key) => !referencedKeys.has(key));
  result.referenced = candidates.length - orphans.length;
  result.capped = orphans.length > MAX_DELETES_PER_RUN;

  const { deleted, failed } = await deleteAvatarKeys(orphans.slice(0, MAX_DELETES_PER_RUN), signal);
  result.deleted = deleted;
  result.failed = failed;
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
    } catch (error) {
      if (signal.aborted) return;
      this.consecutiveFailures += 1;
      logger.error('Avatar sweep failed; nothing deleted this run', {
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
