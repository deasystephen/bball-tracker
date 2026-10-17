/**
 * Helpers for asserting a service's info-level domain event (#686): exactly
 * one line with the given message, whose context the caller compares with
 * `toEqual` so any extra key (a name, an email, request-body text) fails.
 */
import { logger } from '../../src/utils/logger';

/** Silenced spy on `logger.info`; call `mockRestore()` at the end of the test. */
export function spyOnInfo(): jest.SpyInstance {
  return jest.spyOn(logger, 'info').mockImplementation(() => undefined);
}

/** The context of the one `logger.info(message, …)` call; fails unless there is exactly one. */
export function domainEvent(spy: jest.SpyInstance, message: string): Record<string, unknown> {
  const calls = spy.mock.calls.filter(([msg]) => msg === message);
  expect(calls).toHaveLength(1);
  return calls[0][1] as Record<string, unknown>;
}
