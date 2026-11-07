/**
 * The shared Redis back-off (#452): memory during the window after a failure,
 * then exactly one probe at a time; one warn per outage, one info on recovery;
 * a missing or not-ready client is never an outage.
 */
import { logger } from '../../src/utils/logger';
import {
  REDIS_RETRY_AFTER_FAILURE_MS,
  RedisBackoff,
  RedisUnavailableError,
} from '../../src/utils/redis-backoff';

describe('RedisBackoff', () => {
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
    jest.useRealTimers();
  });

  it('passes values through while healthy', async () => {
    const backoff = new RedisBackoff();
    await expect(backoff.attempt('op', async () => 7)).resolves.toEqual({ ok: true, value: 7 });
    expect(backoff.isDegraded()).toBe(false);
  });

  it('treats a missing client as "use memory", not an outage', async () => {
    const backoff = new RedisBackoff();
    await expect(
      backoff.attempt('op', async () => {
        throw new RedisUnavailableError();
      })
    ).resolves.toEqual({ ok: false });
    expect(backoff.isDegraded()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips Redis for the window after a failure, then lets one probe through', async () => {
    const backoff = new RedisBackoff();
    await backoff.attempt('op', async () => {
      throw new Error('Command timed out');
    });
    expect(warn).toHaveBeenCalledTimes(1);

    const op = jest.fn(async () => 1);
    await expect(backoff.attempt('op', op)).resolves.toEqual({ ok: false });
    expect(op).not.toHaveBeenCalled();

    jest.setSystemTime(1_000_000 + REDIS_RETRY_AFTER_FAILURE_MS);
    await expect(backoff.attempt('op', op)).resolves.toEqual({ ok: true, value: 1 });
    expect(info).toHaveBeenCalledWith('Rate limit store: Redis recovered');
    expect(backoff.isDegraded()).toBe(false);
  });

  it('single-flight: while the probe is in flight every other caller uses memory at once', async () => {
    const backoff = new RedisBackoff();
    await backoff.attempt('op', async () => {
      throw new Error('Command timed out');
    });
    jest.setSystemTime(1_000_000 + REDIS_RETRY_AFTER_FAILURE_MS);

    let finishProbe: (value: number) => void = () => undefined;
    const probe = backoff.attempt('op', () => new Promise<number>((resolve) => (finishProbe = resolve)));
    const others = jest.fn(async () => 2);
    for (let i = 0; i < 5; i++) {
      await expect(backoff.attempt('op', others)).resolves.toEqual({ ok: false });
    }
    expect(others).not.toHaveBeenCalled();

    finishProbe(1);
    await expect(probe).resolves.toEqual({ ok: true, value: 1 });
    await expect(backoff.attempt('op', others)).resolves.toEqual({ ok: true, value: 2 });
  });

  it('a failed probe starts a new window and does not warn again', async () => {
    const backoff = new RedisBackoff();
    const fail = async (): Promise<never> => {
      throw new Error('Command timed out');
    };
    await backoff.attempt('op', fail);
    jest.setSystemTime(1_000_000 + REDIS_RETRY_AFTER_FAILURE_MS);
    await backoff.attempt('op', fail);
    expect(warn).toHaveBeenCalledTimes(1);

    const op = jest.fn(async () => 1);
    jest.setSystemTime(1_000_000 + REDIS_RETRY_AFTER_FAILURE_MS + 1);
    await expect(backoff.attempt('op', op)).resolves.toEqual({ ok: false });
    expect(op).not.toHaveBeenCalled();
  });
});
