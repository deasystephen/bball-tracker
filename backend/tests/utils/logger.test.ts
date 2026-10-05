/**
 * `LOG_LEVEL` threshold and ambient request context on the structured logger
 * (#617). Debug used to be gated on `NODE_ENV === 'development'`, which made
 * it impossible to turn on for a production diagnosis.
 */

import { logger, currentLogLevel, isLevelEnabled, DEFAULT_LOG_LEVEL } from '../../src/utils/logger';
import { runWithLogContext, setLogContextUser, getLogContext } from '../../src/utils/log-context';
import { parseLogLines } from '../support/log-lines';

describe('utils/logger', () => {
  const originalLevel = process.env.LOG_LEVEL;
  let out: jest.SpyInstance;
  let err: jest.SpyInstance;

  beforeEach(() => {
    out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    out.mockRestore();
    err.mockRestore();
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
  });

  describe('LOG_LEVEL', () => {
    it('defaults to info: debug is dropped, info / warn / error are written', () => {
      delete process.env.LOG_LEVEL;
      expect(currentLogLevel()).toBe(DEFAULT_LOG_LEVEL);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(parseLogLines(out).map((e) => e.level)).toEqual(['info', 'warn']);
      expect(parseLogLines(err).map((e) => e.level)).toEqual(['error']);
    });

    it('LOG_LEVEL=debug enables debug regardless of NODE_ENV', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(process.env.NODE_ENV).not.toBe('development');

      logger.debug('d', { gameId: 'g1' });

      expect(parseLogLines(out)).toEqual([
        expect.objectContaining({ level: 'debug', message: 'd', gameId: 'g1', service: 'bball-tracker-api' }),
      ]);
    });

    it('LOG_LEVEL=warn drops info, keeps warn and error', () => {
      process.env.LOG_LEVEL = 'warn';

      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(parseLogLines(out).map((e) => e.level)).toEqual(['warn']);
      expect(parseLogLines(err).map((e) => e.level)).toEqual(['error']);
    });

    it('LOG_LEVEL=error keeps only errors', () => {
      process.env.LOG_LEVEL = 'error';

      logger.warn('w');
      logger.error('e');

      expect(out).not.toHaveBeenCalled();
      expect(parseLogLines(err).map((e) => e.level)).toEqual(['error']);
    });

    it('is case-insensitive and falls back to info on an unknown value', () => {
      process.env.LOG_LEVEL = 'DEBUG';
      expect(currentLogLevel()).toBe('debug');
      expect(isLevelEnabled('debug')).toBe(true);

      process.env.LOG_LEVEL = 'verbose';
      expect(currentLogLevel()).toBe('info');
      expect(isLevelEnabled('debug')).toBe(false);
      expect(isLevelEnabled('info')).toBe(true);
    });

    it('is read on every call, so a change takes effect without a restart', () => {
      process.env.LOG_LEVEL = 'error';
      logger.info('dropped');
      process.env.LOG_LEVEL = 'info';
      logger.info('kept');

      expect(parseLogLines(out).map((e) => e.message)).toEqual(['kept']);
    });
  });

  describe('request context', () => {
    it('has no context outside a request', () => {
      expect(getLogContext()).toBeUndefined();
      logger.info('bare');
      expect(parseLogLines(out)[0]).not.toHaveProperty('requestId');
      expect(parseLogLines(out)[0]).not.toHaveProperty('userId');
    });

    it('merges the ambient requestId and userId into every entry, explicit context winning', async () => {
      await runWithLogContext({ requestId: 'req-1' }, async () => {
        logger.info('before auth');
        setLogContextUser('user-1');
        await Promise.resolve();
        logger.info('after auth', { gameId: 'g1' });
        logger.info('explicit wins', { userId: 'other', requestId: 'req-explicit' });
      });

      const lines = parseLogLines(out);
      expect(lines[0]).toEqual(expect.objectContaining({ message: 'before auth', requestId: 'req-1' }));
      expect(lines[0]).not.toHaveProperty('userId');
      expect(lines[1]).toEqual(
        expect.objectContaining({ message: 'after auth', requestId: 'req-1', userId: 'user-1', gameId: 'g1' })
      );
      expect(lines[2]).toEqual(
        expect.objectContaining({ userId: 'other', requestId: 'req-explicit' })
      );
    });

    it('keeps concurrent requests apart', async () => {
      await Promise.all([
        runWithLogContext({ requestId: 'a' }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          setLogContextUser('user-a');
          logger.info('a');
        }),
        runWithLogContext({ requestId: 'b' }, async () => {
          setLogContextUser('user-b');
          await new Promise((r) => setTimeout(r, 1));
          logger.info('b');
        }),
      ]);

      const byMessage = Object.fromEntries(parseLogLines(out).map((e) => [e.message as string, e]));
      expect(byMessage.a).toEqual(expect.objectContaining({ requestId: 'a', userId: 'user-a' }));
      expect(byMessage.b).toEqual(expect.objectContaining({ requestId: 'b', userId: 'user-b' }));
    });

    it('setLogContextUser is a no-op outside a request', () => {
      expect(() => setLogContextUser('u')).not.toThrow();
      expect(getLogContext()).toBeUndefined();
    });
  });
});
