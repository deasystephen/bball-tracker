/**
 * The structured lines `utils/logger.ts` wrote through a `console.log` or
 * `console.error` spy, parsed. Every line the backend writes is one JSON
 * object, so a non-JSON line throws and fails the test.
 */
export type LogLine = Record<string, unknown> & { message?: string };

export function parseLogLines(spy: jest.SpyInstance): LogLine[] {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as LogLine);
}
