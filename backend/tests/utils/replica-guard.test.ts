import {
  enforceReplicaGuard,
  evaluateReplicaGuard,
  parseMaxReplicas,
  MAX_REPLICAS_ENV_VAR,
  MULTI_REPLICA_SUPPORTED,
  REDIS_ADAPTER_ISSUE,
  SOCKET_ADAPTER_URL_ENV_VAR,
} from '../../src/utils/replica-guard';

const ADAPTER_URL = 'redis://adapter.example.test:6379';

describe('utils/replica-guard (#446)', () => {
  it('names the env vars and the open follow-up issue', () => {
    expect(MAX_REPLICAS_ENV_VAR).toBe('MAX_REPLICAS');
    expect(SOCKET_ADAPTER_URL_ENV_VAR).toBe('REDIS_SOCKET_ADAPTER_URL');
    expect(REDIS_ADAPTER_ISSUE).toBe('#452');
  });

  it('ships single-replica only until the Redis adapter is wired up', () => {
    // Flipping this is part of #452 (install + wire @socket.io/redis-adapter and
    // a shared rate-limit store). Until then an adapter URL must not be accepted
    // as proof of safety — nothing reads it.
    expect(MULTI_REPLICA_SUPPORTED).toBe(false);
  });

  describe('parseMaxReplicas', () => {
    it.each([
      ['1', 1],
      ['2', 2],
      ['10', 10],
      [' 3 ', 3],
    ])('parses %j as %d', (raw, expected) => {
      expect(parseMaxReplicas(raw)).toBe(expected);
    });

    it.each([[undefined], [''], ['   ']])('treats %j as unset', (raw) => {
      expect(parseMaxReplicas(raw)).toBeUndefined();
    });

    it.each([['0'], ['-1'], ['1.5'], ['1e3'], ['0x2'], ['01'], ['+2'], ['two'], ['1 2'], ['NaN'], ['9'.repeat(30)]])(
      'rejects %j as invalid',
      (raw) => {
        expect(parseMaxReplicas(raw)).toBeNull();
      }
    );
  });

  describe('evaluateReplicaGuard', () => {
    describe('outside production', () => {
      it.each([['development'], ['test'], [undefined]])('NODE_ENV=%j starts silently', (nodeEnv) => {
        expect(evaluateReplicaGuard({ NODE_ENV: nodeEnv })).toEqual({
          action: 'start',
          reason: 'not-production',
          maxReplicas: null,
          message: '',
        });
      });

      it('ignores even a multi-replica or invalid ceiling', () => {
        expect(evaluateReplicaGuard({ NODE_ENV: 'development', MAX_REPLICAS: '4' }).action).toBe('start');
        expect(evaluateReplicaGuard({ NODE_ENV: 'test', MAX_REPLICAS: 'nonsense' }).action).toBe('start');
      });
    });

    describe('production', () => {
      it('starts with a ceiling of 1', () => {
        const decision = evaluateReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: '1' });
        expect(decision).toMatchObject({ action: 'start', reason: 'single-replica', maxReplicas: 1 });
        expect(decision.message).toContain('#452');
        expect(decision.message).not.toMatch(/FATAL/i);
      });

      it('starts with a ceiling of 1 whether or not an adapter URL is set', () => {
        const decision = evaluateReplicaGuard({
          NODE_ENV: 'production',
          MAX_REPLICAS: '1',
          REDIS_SOCKET_ADAPTER_URL: ADAPTER_URL,
        });
        expect(decision).toMatchObject({ action: 'start', reason: 'single-replica', maxReplicas: 1 });
      });

      it.each([[undefined], [''], ['  ']])(
        'keeps booting (loud warning, no exit) when the ceiling is unset: %j',
        (raw) => {
          const decision = evaluateReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: raw });
          expect(decision).toMatchObject({ action: 'warn', reason: 'ceiling-unset', maxReplicas: null });
          expect(decision.message).toContain('MAX_REPLICAS is not set');
          expect(decision.message).toContain('#452');
        }
      );

      it('an adapter URL does not silence the unset-ceiling warning', () => {
        const decision = evaluateReplicaGuard({ NODE_ENV: 'production', REDIS_SOCKET_ADAPTER_URL: ADAPTER_URL });
        expect(decision).toMatchObject({ action: 'warn', reason: 'ceiling-unset' });
      });

      it.each([['2'], ['4'], ['100']])('is fatal with a ceiling of %s and no adapter', (raw) => {
        const decision = evaluateReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: raw });
        expect(decision).toMatchObject({
          action: 'exit',
          reason: 'multi-replica-unsupported',
          maxReplicas: Number(raw),
        });
        expect(decision.message).toContain(`MAX_REPLICAS=${raw}`);
        expect(decision.message).toContain('#452');
      });

      it('is STILL fatal above 1 when an adapter URL is set, because nothing reads it yet', () => {
        const decision = evaluateReplicaGuard({
          NODE_ENV: 'production',
          MAX_REPLICAS: '2',
          REDIS_SOCKET_ADAPTER_URL: ADAPTER_URL,
        });
        expect(decision).toMatchObject({ action: 'exit', reason: 'multi-replica-unsupported', maxReplicas: 2 });
        expect(decision.message).toContain('REDIS_SOCKET_ADAPTER_URL has no effect');
      });

      it.each([['0'], ['-1'], ['1.5'], ['four'], ['1e3'], ['01']])('is fatal for the invalid ceiling %j', (raw) => {
        const decision = evaluateReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: raw });
        expect(decision).toMatchObject({ action: 'exit', reason: 'ceiling-invalid', maxReplicas: null });
        expect(decision.message).toContain(JSON.stringify(raw));
      });

      it('an adapter URL does not rescue an invalid ceiling', () => {
        const decision = evaluateReplicaGuard(
          { NODE_ENV: 'production', MAX_REPLICAS: 'four', REDIS_SOCKET_ADAPTER_URL: ADAPTER_URL },
          { multiReplicaSupported: true }
        );
        expect(decision).toMatchObject({ action: 'exit', reason: 'ceiling-invalid' });
      });
    });

    describe('once the adapter is wired up (multiReplicaSupported, #452)', () => {
      const options = { multiReplicaSupported: true };

      it('is fatal above 1 without the adapter URL', () => {
        const decision = evaluateReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: '3' }, options);
        expect(decision).toMatchObject({ action: 'exit', reason: 'multi-replica-without-adapter', maxReplicas: 3 });
      });

      it('treats a blank adapter URL as unset', () => {
        const decision = evaluateReplicaGuard(
          { NODE_ENV: 'production', MAX_REPLICAS: '3', REDIS_SOCKET_ADAPTER_URL: '   ' },
          options
        );
        expect(decision).toMatchObject({ action: 'exit', reason: 'multi-replica-without-adapter' });
      });

      it('starts above 1 with the adapter URL', () => {
        const decision = evaluateReplicaGuard(
          { NODE_ENV: 'production', MAX_REPLICAS: '3', REDIS_SOCKET_ADAPTER_URL: ADAPTER_URL },
          options
        );
        expect(decision).toMatchObject({ action: 'start', reason: 'multi-replica-with-adapter', maxReplicas: 3 });
      });

      it('still starts with a ceiling of 1 and no adapter', () => {
        const decision = evaluateReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: '1' }, options);
        expect(decision).toMatchObject({ action: 'start', reason: 'single-replica' });
      });
    });

    it('defaults to process.env when no env is passed', () => {
      // Jest runs with NODE_ENV=test, so the real environment is never production.
      expect(evaluateReplicaGuard().reason).toBe('not-production');
    });
  });

  describe('enforceReplicaGuard', () => {
    const log = { info: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    const deps = { log, exit };

    beforeEach(() => {
      log.info.mockClear();
      log.error.mockClear();
      exit.mockClear();
    });

    it('exits non-zero and logs an error when the ceiling is above 1', () => {
      const decision = enforceReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: '4' }, deps);
      expect(decision.action).toBe('exit');
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Refusing to start'), {
        guard: 'replica-ceiling',
        reason: 'multi-replica-unsupported',
        maxReplicas: 4,
      });
      expect(log.info).not.toHaveBeenCalled();
    });

    it('logs the error before exiting', () => {
      const order: string[] = [];
      enforceReplicaGuard(
        { NODE_ENV: 'production', MAX_REPLICAS: '2' },
        { log: { info: jest.fn(), error: () => order.push('error') }, exit: () => order.push('exit') }
      );
      expect(order).toEqual(['error', 'exit']);
    });

    it('exits non-zero for an invalid ceiling', () => {
      enforceReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: 'four' }, deps);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.error).toHaveBeenCalledTimes(1);
    });

    it('logs loudly but does NOT exit when the ceiling is unset', () => {
      const decision = enforceReplicaGuard({ NODE_ENV: 'production' }, deps);
      expect(decision.action).toBe('warn');
      expect(exit).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('MAX_REPLICAS is not set'), {
        guard: 'replica-ceiling',
        reason: 'ceiling-unset',
        maxReplicas: null,
      });
    });

    it('logs at info and does not exit with a ceiling of 1', () => {
      enforceReplicaGuard({ NODE_ENV: 'production', MAX_REPLICAS: '1' }, deps);
      expect(exit).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledTimes(1);
    });

    it('is silent outside production', () => {
      enforceReplicaGuard({ NODE_ENV: 'development', MAX_REPLICAS: '4' }, deps);
      expect(exit).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    });

    it('passes options through to the decision', () => {
      const decision = enforceReplicaGuard(
        { NODE_ENV: 'production', MAX_REPLICAS: '2', REDIS_SOCKET_ADAPTER_URL: ADAPTER_URL },
        deps,
        { multiReplicaSupported: true }
      );
      expect(decision.reason).toBe('multi-replica-with-adapter');
      expect(exit).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledTimes(1);
    });

    it('defaults to process.env and the real logger (non-production: no log, no exit)', () => {
      expect(enforceReplicaGuard().reason).toBe('not-production');
    });
  });
});
