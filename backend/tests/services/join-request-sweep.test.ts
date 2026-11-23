/**
 * The join-request sweep (#1075) against the mocked Prisma: the batched
 * expiry in `JoinLinkService.expireLapsedRequests` and the scheduler in
 * `services/join-request-sweep.ts` (interval, first run, no overlap, failure
 * handling, stop). The real Postgres is in
 * `tests/integration/join-link.db.test.ts`.
 */
jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));

import { mockPrisma } from '../setup';
import { captureException } from '../../src/utils/sentry';
import { logger } from '../../src/utils/logger';
import { domainEvent, spyOnInfo } from '../support/domain-events';
import {
  JOIN_REQUEST_SWEEP_BATCH,
  JOIN_REQUEST_TTL_DAYS,
  JoinLinkService,
} from '../../src/services/join-link-service';
import {
  JOIN_REQUEST_SWEEP_FIRST_RUN_MS,
  JOIN_REQUEST_SWEEP_INTERVAL_MS,
  JOIN_REQUEST_SWEEP_STALL_MS,
  startJoinRequestSweep,
  stopJoinRequestSweep,
  sweepLapsedJoinRequests,
} from '../../src/services/join-request-sweep';

const DAY_MS = 24 * 60 * 60 * 1000;
const findMany = mockPrisma.teamJoinRequest.findMany as jest.Mock;
const updateMany = mockPrisma.teamJoinRequest.updateMany as jest.Mock;

function rows(count: number, teamId = 'team-1'): Array<{ id: string; teamId: string }> {
  return Array.from({ length: count }, (_, i) => ({ id: `r-${teamId}-${i}`, teamId }));
}

beforeEach(async () => {
  // A successful sweep first, so no test inherits another's failure streak.
  findMany.mockReset();
  findMany.mockResolvedValueOnce([]);
  await sweepLapsedJoinRequests();
  jest.clearAllMocks();
  findMany.mockReset();
  updateMany.mockReset();
});

afterEach(() => {
  stopJoinRequestSweep();
});

describe('JoinLinkService.expireLapsedRequests', () => {
  it('writes nothing and logs nothing when no request has lapsed', async () => {
    findMany.mockResolvedValueOnce([]);
    const info = spyOnInfo();

    expect(await JoinLinkService.expireLapsedRequests()).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('lapses with the lazy expiry\'s rule and write, re-checking the lapse in the UPDATE', async () => {
    findMany.mockResolvedValueOnce([...rows(2, 'team-1'), ...rows(1, 'team-2')]);
    updateMany.mockResolvedValueOnce({ count: 3 });
    const info = spyOnInfo();
    const before = Date.now();

    expect(await JoinLinkService.expireLapsedRequests()).toBe(3);

    const read = findMany.mock.calls[0][0] as {
      where: { status: string; createdAt: { lt: Date } };
      take: number;
      orderBy: unknown;
    };
    expect(read.where.status).toBe('PENDING');
    expect(Math.abs(read.where.createdAt.lt.getTime() - (before - JOIN_REQUEST_TTL_DAYS * DAY_MS))).toBeLessThan(5000);
    expect(read.take).toBe(JOIN_REQUEST_SWEEP_BATCH);
    expect(read.orderBy).toEqual({ createdAt: 'asc' });

    const write = updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] }; status: string; createdAt: { lt: Date } };
      data: Record<string, unknown>;
    };
    expect(write.where.id.in).toEqual(['r-team-1-0', 'r-team-1-1', 'r-team-2-0']);
    expect(write.where.status).toBe('PENDING');
    expect(write.where.createdAt.lt).toEqual(read.where.createdAt.lt);
    // The typed name goes with the lapse, exactly as on the lazy path.
    expect(write.data).toEqual({ status: 'EXPIRED', decidedAt: expect.any(Date), childName: null });

    // Counts only: no request ids, no names.
    expect(domainEvent(info, 'Join requests expired')).toEqual({ expiredCount: 3, teamCount: 2, trigger: 'sweep' });
  });

  it('works through a backlog in batches of JOIN_REQUEST_SWEEP_BATCH until a short batch', async () => {
    findMany
      .mockResolvedValueOnce(rows(JOIN_REQUEST_SWEEP_BATCH, 'a'))
      .mockResolvedValueOnce(rows(JOIN_REQUEST_SWEEP_BATCH, 'b'))
      .mockResolvedValueOnce(rows(7, 'c'));
    updateMany
      .mockResolvedValueOnce({ count: JOIN_REQUEST_SWEEP_BATCH })
      .mockResolvedValueOnce({ count: JOIN_REQUEST_SWEEP_BATCH })
      .mockResolvedValueOnce({ count: 7 });
    const info = spyOnInfo();

    expect(await JoinLinkService.expireLapsedRequests()).toBe(JOIN_REQUEST_SWEEP_BATCH * 2 + 7);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(updateMany).toHaveBeenCalledTimes(3);
    for (const [args] of updateMany.mock.calls as Array<[{ where: { id: { in: string[] } } }]>) {
      expect(args.where.id.in.length).toBeLessThanOrEqual(JOIN_REQUEST_SWEEP_BATCH);
    }
    expect(domainEvent(info, 'Join requests expired')).toEqual({
      expiredCount: JOIN_REQUEST_SWEEP_BATCH * 2 + 7,
      teamCount: 3,
      trigger: 'sweep',
    });
  });

  it('stops after a full batch that changed nothing (all decided meanwhile) rather than spin', async () => {
    findMany.mockResolvedValue(rows(JOIN_REQUEST_SWEEP_BATCH));
    updateMany.mockResolvedValue({ count: 0 });
    const info = spyOnInfo();

    expect(await JoinLinkService.expireLapsedRequests()).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('sweepLapsedJoinRequests', () => {
  it('returns what the service expired', async () => {
    findMany.mockResolvedValueOnce(rows(2));
    updateMany.mockResolvedValueOnce({ count: 2 });
    spyOnInfo();
    expect(await sweepLapsedJoinRequests()).toBe(2);
  });

  it('never throws on a database failure, reporting only the first failure of a streak', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    findMany.mockRejectedValue(new Error('db down'));

    expect(await sweepLapsedJoinRequests()).toBe(0);
    expect(await sweepLapsedJoinRequests()).toBe(0);
    expect(warn).toHaveBeenCalledWith('Join request sweep failed', { error: 'db down' });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { flow: 'join-request-sweep' });

    // Recovery resets the streak: the next outage is reported again.
    findMany.mockResolvedValueOnce([]);
    expect(await sweepLapsedJoinRequests()).toBe(0);
    findMany.mockRejectedValueOnce(new Error('db down again'));
    await sweepLapsedJoinRequests();
    expect(captureException).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('startJoinRequestSweep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('first runs JOIN_REQUEST_SWEEP_FIRST_RUN_MS after start, then every interval, never overlapping, until stopped', async () => {
    let release: (value: Array<{ id: string; teamId: string }>) => void = () => undefined;
    findMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    startJoinRequestSweep();

    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_FIRST_RUN_MS - 1);
    expect(findMany).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(findMany).toHaveBeenCalledTimes(1);

    // Still in flight at the first interval tick: skipped.
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_INTERVAL_MS - JOIN_REQUEST_SWEEP_FIRST_RUN_MS);
    expect(findMany).toHaveBeenCalledTimes(1);

    release([]);
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(2);

    stopJoinRequestSweep();
    stopJoinRequestSweep();
    release([]);
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_INTERVAL_MS * 3);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('a second start replaces the first: one timer, one first run', async () => {
    findMany.mockResolvedValue([]);
    startJoinRequestSweep();
    startJoinRequestSweep();
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('keeps sweeping after a failed run', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    findMany.mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
    startJoinRequestSweep();
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reports a sweep that throws outside the query as a defect and keeps sweeping', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    findMany.mockRejectedValue(new Error('db down'));
    // The failure path itself throws once (a defect in the reporting).
    (captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sentry broke');
    });
    startJoinRequestSweep();
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_FIRST_RUN_MS);
    expect(error).toHaveBeenCalledWith('Join request sweep error', { error: 'sentry broke' });
    expect(captureException).toHaveBeenLastCalledWith(expect.any(Error), { flow: 'join-request-sweep' });

    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    error.mockRestore();
  });

  it('does not report a query that fails after the sweep was stopped (shutdown)', async () => {
    let fail: (error: Error) => void = () => undefined;
    findMany.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        })
    );
    startJoinRequestSweep();
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_FIRST_RUN_MS);
    stopJoinRequestSweep();
    fail(new Error('Prisma disconnected'));
    await jest.advanceTimersByTimeAsync(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports a sweep that never settles once, and runs none beside it', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    findMany.mockImplementation(() => new Promise(() => undefined));
    // An interval shorter than the stall bound, so ticks land while it hangs.
    const interval = JOIN_REQUEST_SWEEP_STALL_MS / 5;
    startJoinRequestSweep(interval, interval);

    await jest.advanceTimersByTimeAsync(interval);
    await jest.advanceTimersByTimeAsync(JOIN_REQUEST_SWEEP_STALL_MS - interval);
    expect(captureException).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(interval * 5);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Join request sweep stalled' }),
      expect.objectContaining({ flow: 'join-request-sweep' })
    );
    error.mockRestore();
  });
});
