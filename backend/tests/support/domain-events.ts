/**
 * Helpers for asserting a service's info-level domain event (#686): exactly
 * one line with the given message, whose context the caller compares with
 * `toEqual` so any extra key (a name, an email, request-body text) fails.
 *
 * Importing this module installs an `afterEach` that restores every spy
 * `spyOnInfo` created, so a failing assertion never leaves `logger.info`
 * silenced for the rest of the file. It restores only its own spies: the
 * config-wide `restoreMocks: true` would also reset the module-scope
 * `jest.fn()` implementations in `tests/setup.ts` (the `$transaction` mock).
 */
import { logger } from '../../src/utils/logger';

const active: jest.SpyInstance[] = [];

afterEach(() => {
  for (const spy of active.splice(0)) spy.mockRestore();
});

/** Silenced spy on `logger.info`, restored automatically after the test. */
export function spyOnInfo(): jest.SpyInstance {
  const spy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  active.push(spy);
  return spy;
}

/** The context of the one `logger.info(message, …)` call; fails unless there is exactly one. */
export function domainEvent(spy: jest.SpyInstance, message: string): Record<string, unknown> {
  const calls = spy.mock.calls.filter(([msg]) => msg === message);
  expect(calls).toHaveLength(1);
  return calls[0][1] as Record<string, unknown>;
}
