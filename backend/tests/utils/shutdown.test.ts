/**
 * The SIGTERM/SIGINT routine (#747, #1052): closers run in order, each under
 * its own bound and logged as a step; a stuck closer is abandoned without
 * starving the next ones; the hard-exit timer names the steps still pending.
 */
import {
  createShutdown,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_HTTP_DRAIN_MS,
  STEP_TIMEOUT_MS,
  type ShutdownDeps,
} from '../../src/utils/shutdown';
import { logger } from '../../src/utils/logger';
import { spyOnInfo } from '../support/domain-events';

const never = (): Promise<void> => new Promise<void>(() => undefined);

function deps(overrides: Partial<ShutdownDeps> = {}): { deps: ShutdownDeps; order: string[] } {
  const order: string[] = [];
  const step = (name: string): jest.Mock<Promise<void>, []> =>
    jest.fn(async () => {
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
    });
  return {
    order,
    deps: {
      io: { close: step('io') },
      consumer: { stop: step('consumer') },
      disconnectPrisma: step('prisma'),
      closeRedis: step('redis'),
      exit: jest.fn((code: number) => {
        order.push(`exit:${code}`);
      }),
      ...overrides,
    },
  };
}

/** Let pending promise callbacks run between fake-timer advances. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await flush();
}

let info: jest.SpyInstance;
beforeEach(() => {
  info = spyOnInfo();
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createShutdown', () => {
  it('stays under the ECS default stopTimeout of 30 s', () => {
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(30_000);
  });

  it('bounds the steps so that, run back to back, they end inside the grace period', () => {
    const serial = STEP_TIMEOUT_MS.http + STEP_TIMEOUT_MS['ses-consumer'] +
      Math.max(STEP_TIMEOUT_MS.prisma, STEP_TIMEOUT_MS.redis);
    expect(serial).toBeLessThan(SHUTDOWN_GRACE_MS);
    expect(STEP_TIMEOUT_MS.http).toBeGreaterThan(SHUTDOWN_HTTP_DRAIN_MS);
  });

  it('closes Socket.io, then the SES consumer, then Prisma and Redis, then exits 0', async () => {
    const { deps: d, order } = deps();
    await createShutdown(d)('SIGTERM');

    expect(order.indexOf('io:end')).toBeLessThan(order.indexOf('consumer:start'));
    expect(order.indexOf('consumer:end')).toBeLessThan(order.indexOf('prisma:start'));
    expect(order.indexOf('consumer:end')).toBeLessThan(order.indexOf('redis:start'));
    expect(order.at(-1)).toBe('exit:0');
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Shutting down', { signal: 'SIGTERM' });
    expect(logger.info).toHaveBeenCalledWith('Shutdown complete', { signal: 'SIGTERM' });
  });

  it('logs every step started and finished, with names and durations only', async () => {
    const { deps: d } = deps();
    await createShutdown(d)('SIGTERM');

    const started = info.mock.calls.filter(([m]) => m === 'Shutdown step started').map(([, c]) => c);
    expect(started).toEqual(
      ['http', 'ses-consumer', 'prisma', 'redis'].map((step) => ({ signal: 'SIGTERM', step }))
    );
    const finished = info.mock.calls.filter(([m]) => m === 'Shutdown step finished').map(([, c]) => c);
    expect(finished).toHaveLength(4);
    for (const context of finished) {
      expect(Object.keys(context).sort()).toEqual(['durationMs', 'outcome', 'signal', 'step']);
      expect(context.outcome).toBe('ok');
      expect(typeof context.durationMs).toBe('number');
    }
  });

  it('tolerates a missing SES consumer', async () => {
    const { deps: d } = deps({ consumer: null });
    await createShutdown(d)('SIGINT');
    expect(d.disconnectPrisma).toHaveBeenCalled();
    expect(d.closeRedis).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(info.mock.calls.some(([m, c]) => m === 'Shutdown step started' && c.step === 'ses-consumer')).toBe(false);
  });

  it('still exits 0 when Prisma or Redis fails to quit, and warns for each', async () => {
    const { deps: d } = deps({
      disconnectPrisma: jest.fn().mockRejectedValue(new Error('pg gone')),
      closeRedis: jest.fn().mockRejectedValue(new Error('redis gone')),
    });
    await createShutdown(d)('SIGTERM');
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('Shutdown step finished', {
      signal: 'SIGTERM',
      step: 'prisma',
      outcome: 'failed',
      durationMs: expect.any(Number),
      error: 'pg gone',
    });
    expect(logger.warn).toHaveBeenCalledWith('Shutdown step finished', {
      signal: 'SIGTERM',
      step: 'redis',
      outcome: 'failed',
      durationMs: expect.any(Number),
      error: 'redis gone',
    });
  });

  it('exits 1 when an ordered closer throws, after the later closers still ran', async () => {
    const { deps: d } = deps({ io: { close: jest.fn().mockRejectedValue(new Error('io broke')) } });
    await createShutdown(d)('SIGTERM');
    expect(d.consumer?.stop).toHaveBeenCalled();
    expect(d.disconnectPrisma).toHaveBeenCalled();
    expect(d.closeRedis).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Shutdown incomplete', {
      signal: 'SIGTERM',
      abandonedSteps: [],
      failedSteps: ['http'],
    });
  });

  it('treats a closer that throws synchronously as a failed step', async () => {
    const { deps: d } = deps({
      consumer: {
        stop: jest.fn(() => {
          throw new Error('sync');
        }),
      },
    });
    await createShutdown(d)('SIGTERM');
    expect(d.disconnectPrisma).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('destroys the connections still open after the drain period, and the HTTP step then finishes', async () => {
    jest.useFakeTimers();
    let release: () => void = () => undefined;
    const close = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const destroyConnections = jest.fn(() => {
      release();
      return 2;
    });
    const { deps: d } = deps({ io: { close }, destroyConnections });
    const done = createShutdown(d)('SIGTERM');

    await advance(SHUTDOWN_HTTP_DRAIN_MS - 1);
    expect(destroyConnections).not.toHaveBeenCalled();
    await advance(1);
    expect(destroyConnections).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Shutdown: destroyed connections still open', {
      signal: 'SIGTERM',
      count: 2,
      afterMs: SHUTDOWN_HTTP_DRAIN_MS,
    });
    await done;
    expect(d.consumer?.stop).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('abandons a closer that never settles, gives the next ones their turn, and exits 1 naming it', async () => {
    jest.useFakeTimers();
    const { deps: d } = deps({ consumer: { stop: jest.fn(never) } });
    const done = createShutdown(d)('SIGTERM');

    await advance(STEP_TIMEOUT_MS['ses-consumer'] - 1);
    expect(d.disconnectPrisma).not.toHaveBeenCalled();
    await advance(1);
    await done;

    expect(d.disconnectPrisma).toHaveBeenCalled();
    expect(d.closeRedis).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Shutdown step finished', {
      signal: 'SIGTERM',
      step: 'ses-consumer',
      outcome: 'timed-out',
      durationMs: expect.any(Number),
      timeoutMs: STEP_TIMEOUT_MS['ses-consumer'],
    });
    expect(logger.error).toHaveBeenCalledWith('Shutdown incomplete', {
      signal: 'SIGTERM',
      abandonedSteps: ['ses-consumer'],
      failedSteps: [],
    });
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('abandons an HTTP close that outlives the destroy, then still quits everything else', async () => {
    jest.useFakeTimers();
    const destroyConnections = jest.fn(() => 1);
    const { deps: d } = deps({ io: { close: jest.fn(never) }, destroyConnections });
    const done = createShutdown(d)('SIGTERM');
    await advance(STEP_TIMEOUT_MS.http);
    await done;
    expect(destroyConnections).toHaveBeenCalledTimes(1);
    expect(d.consumer?.stop).toHaveBeenCalled();
    expect(d.disconnectPrisma).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Shutdown incomplete', {
      signal: 'SIGTERM',
      abandonedSteps: ['http'],
      failedSteps: [],
    });
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('forces exit(1) after the grace period, naming the steps still pending', async () => {
    jest.useFakeTimers();
    const graceMs = 1_000;
    const { deps: d } = deps({ io: { close: jest.fn(never) }, graceMs });
    void createShutdown(d)('SIGTERM');
    await flush();

    await advance(graceMs - 1);
    expect(d.exit).not.toHaveBeenCalled();
    await advance(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Shutdown grace period elapsed; forcing exit', {
      signal: 'SIGTERM',
      pendingSteps: ['http'],
    });
  });

  it('keeps the hard-exit timer ref\'d, so a closer that never settles still ends in exit(1)', async () => {
    jest.useFakeTimers();
    const { deps: d } = deps({ io: { close: jest.fn(never) } });
    void createShutdown(d)('SIGTERM');
    await flush();

    jest.runOnlyPendingTimers();
    await flush();
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('clears every timer once the sequence finishes', async () => {
    jest.useFakeTimers();
    const { deps: d } = deps();
    await createShutdown(d)('SIGTERM');
    expect(jest.getTimerCount()).toBe(0);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it('runs once even when a second signal arrives mid-shutdown', async () => {
    const { deps: d } = deps();
    const shutdown = createShutdown(d);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(d.io.close).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });
});
