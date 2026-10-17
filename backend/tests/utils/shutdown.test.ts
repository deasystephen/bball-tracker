/**
 * The SIGTERM/SIGINT routine (#747): closers run in order, then exit(0); a
 * hanging closer is cut off by the hard-exit timer with exit(1).
 */
import { createShutdown, SHUTDOWN_GRACE_MS, type ShutdownDeps } from '../../src/utils/shutdown';
import { logger } from '../../src/utils/logger';

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

beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
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

  it('closes Socket.io, then the SES consumer, then Prisma and Redis, then exits 0', async () => {
    const { deps: d, order } = deps();
    await createShutdown(d)('SIGTERM');

    expect(order.indexOf('io:end')).toBeLessThan(order.indexOf('consumer:start'));
    expect(order.indexOf('consumer:end')).toBeLessThan(order.indexOf('prisma:start'));
    expect(order.indexOf('consumer:end')).toBeLessThan(order.indexOf('redis:start'));
    expect(order.at(-1)).toBe('exit:0');
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Shutting down', { signal: 'SIGTERM' });
  });

  it('tolerates a missing SES consumer', async () => {
    const { deps: d } = deps({ consumer: null });
    await createShutdown(d)('SIGINT');
    expect(d.disconnectPrisma).toHaveBeenCalled();
    expect(d.closeRedis).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('still exits 0 when Prisma or Redis fails to quit, and warns for each', async () => {
    const { deps: d } = deps({
      disconnectPrisma: jest.fn().mockRejectedValue(new Error('pg gone')),
      closeRedis: jest.fn().mockRejectedValue(new Error('redis gone')),
    });
    await createShutdown(d)('SIGTERM');
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('Shutdown: connection did not quit cleanly', {
      signal: 'SIGTERM',
      client: 'prisma',
      error: 'pg gone',
    });
    expect(logger.warn).toHaveBeenCalledWith('Shutdown: connection did not quit cleanly', {
      signal: 'SIGTERM',
      client: 'redis',
      error: 'redis gone',
    });
  });

  it('exits 1 when an ordered closer throws', async () => {
    const { deps: d } = deps({ io: { close: jest.fn().mockRejectedValue(new Error('io broke')) } });
    await createShutdown(d)('SIGTERM');
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.disconnectPrisma).not.toHaveBeenCalled();
  });

  it('forces exit(1) after the grace period when a closer hangs', async () => {
    jest.useFakeTimers();
    const { deps: d } = deps({ consumer: { stop: jest.fn(() => new Promise<void>(() => undefined)) } });
    void createShutdown(d)('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(SHUTDOWN_GRACE_MS - 1);
    expect(d.exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it('keeps the hard-exit timer ref\'d, so a closer that never settles still ends in exit(1)', async () => {
    jest.useFakeTimers();
    const { deps: d } = deps({ io: { close: jest.fn(() => new Promise<void>(() => undefined)) } });
    void createShutdown(d)('SIGTERM');
    await Promise.resolve();

    const timers = jest.getTimerCount();
    expect(timers).toBe(1);
    jest.runOnlyPendingTimers();
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('clears the hard-exit timer once the sequence finishes', async () => {
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
