/**
 * The periodic sweep of unreferenced avatar uploads (#957): only issued keys
 * older than 24 h that no `User.profilePictureUrl` references are deleted;
 * any read failure deletes nothing; the scheduler serializes runs and stops
 * cleanly.
 */

jest.mock('../../src/services/upload-service', () => ({
  ...jest.requireActual('../../src/services/upload-service'),
  listAvatarObjects: jest.fn(),
  loadReferencedAvatarKeys: jest.fn(),
  deleteAvatarKeys: jest.fn(),
}));
jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));

import {
  AVATAR_SWEEP_FIRST_RUN_DELAY_MS,
  AVATAR_SWEEP_INTERVAL_MS,
  AVATAR_SWEEP_MIN_AGE_MS,
  AvatarSweeper,
  createAvatarSweeper,
  MAX_DELETES_PER_RUN,
  sweepOrphanedAvatars,
  type AvatarSweepResult,
} from '../../src/services/avatar-sweep';
import { deleteAvatarKeys, listAvatarObjects, loadReferencedAvatarKeys } from '../../src/services/upload-service';
import { captureException } from '../../src/utils/sentry';
import { logger } from '../../src/utils/logger';

const mockList = listAvatarObjects as jest.Mock;
const mockRefs = loadReferencedAvatarKeys as jest.Mock;
const mockDelete = deleteAvatarKeys as jest.Mock;
const mockCapture = captureException as jest.Mock;

const NOW = new Date('2026-11-06T12:00:00Z');
const OLD = new Date(NOW.getTime() - AVATAR_SWEEP_MIN_AGE_MS - 1);
const EXACTLY_CUTOFF = new Date(NOW.getTime() - AVATAR_SWEEP_MIN_AGE_MS);
const FRESH = new Date(NOW.getTime() - AVATAR_SWEEP_MIN_AGE_MS + 60_000);

const EMPTY_RESULT: AvatarSweepResult = {
  listed: 0,
  candidates: 0,
  referenced: 0,
  deleted: 0,
  failed: 0,
  capped: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  mockRefs.mockResolvedValue(new Set());
  mockDelete.mockImplementation(async (keys: string[]) => ({ deleted: keys.length, failed: 0 }));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sweepOrphanedAvatars', () => {
  it('deletes only old, issued, unreferenced keys', async () => {
    mockList.mockResolvedValue([
      { key: 'avatars/u/orphan.jpg', lastModified: OLD },
      { key: 'avatars/u/cutoff.jpg', lastModified: EXACTLY_CUTOFF },
      { key: 'avatars/coach/kid.jpg', lastModified: OLD },
      { key: 'avatars/u/fresh.jpg', lastModified: FRESH },
      { key: 'avatars/u/nodate.jpg', lastModified: undefined },
      { key: 'avatars/u/x/odd.jpg', lastModified: OLD },
      { key: 'avatars/loose.jpg', lastModified: OLD },
    ]);
    mockRefs.mockResolvedValue(new Set(['avatars/coach/kid.jpg']));

    const result = await sweepOrphanedAvatars(NOW);

    expect(mockList).toHaveBeenCalledWith('avatars/', undefined);
    expect(mockDelete).toHaveBeenCalledWith(['avatars/u/orphan.jpg', 'avatars/u/cutoff.jpg'], undefined);
    expect(result).toEqual({ listed: 7, candidates: 3, referenced: 1, deleted: 2, failed: 0, capped: false });
    expect(logger.info).toHaveBeenCalledWith('Avatar sweep finished', result);
  });

  it('reads references only after the listing', async () => {
    const order: string[] = [];
    mockList.mockImplementation(async () => {
      order.push('list');
      return [{ key: 'avatars/u/a.jpg', lastModified: OLD }];
    });
    mockRefs.mockImplementation(async () => {
      order.push('refs');
      return new Set();
    });
    await sweepOrphanedAvatars(NOW);
    expect(order).toEqual(['list', 'refs']);
  });

  it('skips the reference query and deletes nothing when there are no candidates', async () => {
    mockList.mockResolvedValue([{ key: 'avatars/u/fresh.jpg', lastModified: FRESH }]);
    const result = await sweepOrphanedAvatars(NOW);
    expect(mockRefs).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(result).toEqual({ ...EMPTY_RESULT, listed: 1 });
  });

  it('deletes nothing when the reference query fails', async () => {
    mockList.mockResolvedValue([{ key: 'avatars/u/a.jpg', lastModified: OLD }]);
    mockRefs.mockRejectedValue(new Error('db down'));
    await expect(sweepOrphanedAvatars(NOW)).rejects.toThrow('db down');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes nothing when the listing fails', async () => {
    mockList.mockRejectedValue(new Error('AccessDenied'));
    await expect(sweepOrphanedAvatars(NOW)).rejects.toThrow('AccessDenied');
    expect(mockRefs).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it(`caps one run at ${MAX_DELETES_PER_RUN} deletions`, async () => {
    mockList.mockResolvedValue(
      Array.from({ length: MAX_DELETES_PER_RUN + 5 }, (_, i) => ({ key: `avatars/u/${i}.jpg`, lastModified: OLD }))
    );
    const result = await sweepOrphanedAvatars(NOW);
    expect(mockDelete.mock.calls[0][0]).toHaveLength(MAX_DELETES_PER_RUN);
    expect(result.capped).toBe(true);
  });

  it('defaults to the current time', async () => {
    mockList.mockResolvedValue([]);
    await expect(sweepOrphanedAvatars()).resolves.toEqual(EMPTY_RESULT);
  });
});

describe('AvatarSweeper', () => {
  it('runs after the first-run delay, then every interval after a run finishes', async () => {
    jest.useFakeTimers();
    const sweep = jest.fn().mockResolvedValue(EMPTY_RESULT);
    const sweeper = new AvatarSweeper({ sweep, firstRunDelayMs: 1_000, intervalMs: 5_000 });

    sweeper.start();
    sweeper.start(); // no-op while running
    expect(sweeper.isRunning).toBe(true);

    await jest.advanceTimersByTimeAsync(999);
    expect(sweep).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await sweeper.stop();
    expect(sweeper.isRunning).toBe(false);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('uses the production defaults', async () => {
    jest.useFakeTimers();
    const sweep = jest.fn().mockResolvedValue(EMPTY_RESULT);
    const sweeper = new AvatarSweeper({ sweep });
    sweeper.start();
    await jest.advanceTimersByTimeAsync(AVATAR_SWEEP_FIRST_RUN_DELAY_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(AVATAR_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it('waits for an in-flight run on stop and aborts it', async () => {
    jest.useFakeTimers();
    let release: () => void = () => undefined;
    let seenSignal: AbortSignal | undefined;
    const sweep = jest.fn((_now: Date, signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<AvatarSweepResult>((resolve) => {
        release = () => resolve(EMPTY_RESULT);
      });
    });
    const sweeper = new AvatarSweeper({ sweep, firstRunDelayMs: 0, intervalMs: 1_000 });
    sweeper.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(seenSignal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('stop is a no-op when never started', async () => {
    await expect(new AvatarSweeper().stop()).resolves.toBeUndefined();
  });

  it('logs a failed run, reports the first failure of an outage once, and resets after a success', async () => {
    const sweep = jest
      .fn()
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockRejectedValueOnce('still denied')
      .mockResolvedValueOnce(EMPTY_RESULT)
      .mockRejectedValueOnce(new Error('again'));
    const sweeper = new AvatarSweeper({ sweep });

    await sweeper.runOnce();
    await sweeper.runOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Avatar sweep failed; nothing deleted this run',
      expect.objectContaining({ error: 'still denied', consecutiveFailures: 2 })
    );
    expect(mockCapture).toHaveBeenCalledTimes(1);
    await sweeper.runOnce();
    await sweeper.runOnce();
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });

  it('does not report a failure caused by stopping', async () => {
    jest.useFakeTimers();
    let fail: () => void = () => undefined;
    const sweep = jest.fn(
      () =>
        new Promise<AvatarSweepResult>((_resolve, reject) => {
          fail = () => reject(new Error('Avatar listing aborted'));
        })
    );
    const sweeper = new AvatarSweeper({ sweep, firstRunDelayMs: 0 });
    sweeper.start();
    await jest.advanceTimersByTimeAsync(0);
    const stopping = sweeper.stop();
    fail();
    await stopping;
    expect(logger.error).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('createAvatarSweeper', () => {
  it('is null unless AVATAR_SWEEP_ENABLED is true', () => {
    expect(createAvatarSweeper({})).toBeNull();
    expect(createAvatarSweeper({ AVATAR_SWEEP_ENABLED: 'false' })).toBeNull();
    expect(createAvatarSweeper({ AVATAR_SWEEP_ENABLED: '1' })).toBeNull();
    expect(createAvatarSweeper({ AVATAR_SWEEP_ENABLED: ' TRUE ' })).toBeInstanceOf(AvatarSweeper);
  });

  it('reads process.env by default', () => {
    const previous = process.env.AVATAR_SWEEP_ENABLED;
    delete process.env.AVATAR_SWEEP_ENABLED;
    expect(createAvatarSweeper()).toBeNull();
    if (previous !== undefined) process.env.AVATAR_SWEEP_ENABLED = previous;
  });
});
