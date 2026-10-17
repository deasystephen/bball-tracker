/**
 * The unhandled-rejection policy (#750): one structured log line, a Sentry
 * capture when enabled, keep the process alive, and the same with or without
 * a DSN. Each case loads a fresh `utils/sentry` so its module flags start
 * clean, and removes whatever listener the case added.
 */

type SentryModule = typeof import('../../src/utils/sentry');
type LoggerModule = typeof import('../../src/utils/logger');

const mockSentryInit = jest.fn();
const mockSentryCapture = jest.fn();
const mockScope = { setTags: jest.fn(), setTag: jest.fn(), setUser: jest.fn() };
jest.mock('@sentry/node', () => ({
  init: mockSentryInit,
  captureException: mockSentryCapture,
  withScope: (cb: (scope: typeof mockScope) => void): void => cb(mockScope),
}));

const ORIGINAL_DSN = process.env.SENTRY_DSN;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
let baseline: Array<(...args: unknown[]) => void>;

function load(): { sentry: SentryModule; logger: LoggerModule['logger'] } {
  let sentry: SentryModule | undefined;
  let logger: LoggerModule['logger'] | undefined;
  jest.isolateModules(() => {
    sentry = jest.requireActual('../../src/utils/sentry') as SentryModule;
    logger = (jest.requireActual('../../src/utils/logger') as LoggerModule).logger;
  });
  return { sentry: sentry!, logger: logger! };
}

function addedListeners(): Array<(...args: unknown[]) => void> {
  return (process.listeners('unhandledRejection') as Array<(...args: unknown[]) => void>).filter(
    (l) => !baseline.includes(l)
  );
}

beforeEach(() => {
  baseline = process.listeners('unhandledRejection') as Array<(...args: unknown[]) => void>;
});

afterEach(() => {
  for (const listener of addedListeners()) process.removeListener('unhandledRejection', listener);
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe.each([
  ['unset', undefined],
  ['the "disabled" sentinel', 'disabled'],
  ['a real DSN', 'https://abc@o1.ingest.sentry.io/1'],
])('with SENTRY_DSN %s', (_label, dsn) => {
  beforeEach(() => {
    if (dsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = dsn;
  });

  it('registers exactly one app unhandledRejection listener, however often init runs', () => {
    const { sentry } = load();
    sentry.initSentry();
    sentry.initSentry();
    sentry.installProcessHandlers();
    expect(addedListeners()).toHaveLength(1);
  });

  it('logs one structured error line and keeps running', () => {
    const { sentry, logger } = load();
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    sentry.initSentry();

    const boom = new Error('boom');
    const [listener] = addedListeners();
    expect(() => listener(boom, Promise.resolve())).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Unhandled promise rejection', {
      error: 'boom',
      stack: boom.stack,
    });
  });
});

describe('Sentry wiring', () => {
  it("drops Sentry's own rejection integration (no double capture) and keeps every other default", () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/1';
    const { sentry } = load();
    sentry.initSentry();

    const options = mockSentryInit.mock.calls[0][0] as {
      integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    };
    expect(typeof options.integrations).toBe('function');
    const kept = options.integrations([
      { name: 'OnUncaughtException' },
      { name: sentry.UNHANDLED_REJECTION_INTEGRATION },
      { name: 'Http' },
    ]);
    expect(kept.map((i) => i.name)).toEqual(['OnUncaughtException', 'Http']);
    expect(sentry.UNHANDLED_REJECTION_INTEGRATION).toBe('OnUnhandledRejection');
  });

  it('redacts URLs in the message and leaves the stack out in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SENTRY_DSN;
    const { sentry, logger } = load();
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    sentry.initSentry();

    addedListeners()[0](
      new Error('fetch failed: https://hooplings.com/invite/abcdefghijklmnop?token=s3cret'),
      Promise.resolve()
    );

    expect(errorSpy).toHaveBeenCalledWith('Unhandled promise rejection', {
      error: 'fetch failed: https://hooplings.com/invite/[redacted]?token=[redacted]',
      stack: undefined,
    });
  });

  it('captures the rejection with the process tags when Sentry is enabled', () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/1';
    const { sentry, logger } = load();
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    sentry.initSentry();

    const boom = new Error('boom');
    addedListeners()[0](boom, Promise.resolve());

    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(boom);
    expect(mockScope.setTags).toHaveBeenCalledWith({ flow: 'process', kind: 'unhandledRejection' });
  });

  it('logs a non-Error reason as a string with no stack', () => {
    delete process.env.SENTRY_DSN;
    const { sentry, logger } = load();
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    sentry.initSentry();

    addedListeners()[0]('plain reason', Promise.resolve());

    expect(errorSpy).toHaveBeenCalledWith('Unhandled promise rejection', {
      error: 'plain reason',
      stack: undefined,
    });
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });
});
