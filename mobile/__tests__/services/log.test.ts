/**
 * services/log.ts (#617): debug/info are console-only and only in
 * development; warn/error also reach the breadcrumb sink once one is
 * installed; an Error in the data bag is reduced to name + message.
 */

type LogModule = typeof import('../../services/log');

function loadLog(dev: boolean): LogModule {
  let mod!: LogModule;
  jest.isolateModules(() => {
    (global as unknown as { __DEV__: boolean }).__DEV__ = dev;
    mod = jest.requireActual<LogModule>('../../services/log');
  });
  return mod;
}

describe('services/log', () => {
  const originalDev = (global as unknown as { __DEV__: boolean }).__DEV__;
  let logSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (global as unknown as { __DEV__: boolean }).__DEV__ = originalDev;
  });

  it('prints every level to the console in development', () => {
    const { log } = loadLog(true);
    log.debug('d', { a: 1 });
    log.info('i');
    log.warn('w', { b: 2 });
    log.error('e');

    expect(logSpy).toHaveBeenCalledWith('d', { a: 1 });
    expect(infoSpy).toHaveBeenCalledWith('i');
    expect(warnSpy).toHaveBeenCalledWith('w', { b: 2 });
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('is silent on the console outside development', () => {
    const { log } = loadLog(false);
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('sends warn and error, never debug or info, to the breadcrumb sink', () => {
    const { log, setLogBreadcrumbSink } = loadLog(false);
    const sink = jest.fn();
    setLogBreadcrumbSink(sink);

    log.debug('d');
    log.info('i');
    log.warn('w', { teamId: 't1' });
    log.error('e');

    expect(sink.mock.calls).toEqual([
      ['warning', 'w', { teamId: 't1' }],
      ['error', 'e', undefined],
    ]);

    setLogBreadcrumbSink(null);
    log.error('after removal');
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('reduces an Error in the data bag to name and message for the breadcrumb', () => {
    const { log, setLogBreadcrumbSink, toBreadcrumbData } = loadLog(false);
    const sink = jest.fn();
    setLogBreadcrumbSink(sink);
    const error = new TypeError('boom');

    log.error('failed', { error, attempt: 2 });

    expect(sink).toHaveBeenCalledWith('error', 'failed', {
      error: { name: 'TypeError', message: 'boom' },
      attempt: 2,
    });
    expect(toBreadcrumbData(undefined)).toBeUndefined();
  });

  it('never throws into the caller when the sink does', () => {
    const { log, setLogBreadcrumbSink } = loadLog(false);
    setLogBreadcrumbSink(() => {
      throw new Error('sink down');
    });
    expect(() => log.warn('w')).not.toThrow();
    expect(() => log.error('e')).not.toThrow();
  });
});
