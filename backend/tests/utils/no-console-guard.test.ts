/**
 * Guard for #684: no `console.*` in `src/` outside `utils/logger.ts`.
 *
 * Production logging is one JSON object per line from `utils/logger.ts`,
 * gated by `LOG_LEVEL`, carrying `requestId` / `userId` from the request
 * context (docs/architecture/backend-services.md#logging). A bare console
 * call bypasses all of it, and `utils/redact.ts` / `hashRecipient()` too.
 * ESLint `no-console` (with one override for `src/utils/logger.ts`) is the
 * first line; this suite is the second, and keeps the exception explicit.
 *
 * It fails on ANY reference to the `console` identifier once comments and
 * string / template literals are stripped: `console.log(…)`,
 * `console['error'](…)`, `const { log } = console`, `globalThis.console`.
 * ESLint misses the destructuring form; this does not. The one gap: code
 * inside a template literal's `${…}` is stripped with the template (ESLint
 * still sees a `console.x` call there).
 */
import { readFileSync } from 'fs';
import path from 'path';
import { sourceFiles, stripComments, stripStrings } from '../support/source-scan';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');
const LOGGER = path.join(SRC, 'utils/logger.ts');

/** Any reference to the global `console`, however it is reached. */
const CONSOLE_REFERENCE = /\bconsole\b/g;

export function findConsoleCalls(source: string): string[] {
  return stripStrings(stripComments(source)).match(CONSOLE_REFERENCE) ?? [];
}

describe('no console.* in src/ outside the logger (#684)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = sourceFiles(SRC);
  });

  it('scans the backend source', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(LOGGER);
  });

  it('finds console only in utils/logger.ts', () => {
    const offenders = files
      .filter((file) => findConsoleCalls(readFileSync(file, 'utf8')).length > 0)
      .map((file) => path.relative(BACKEND, file));

    expect(offenders).toEqual([path.relative(BACKEND, LOGGER)]);
  });
});

describe('the guard pattern', () => {
  it.each([
    ["console.log('payload', body);", 1],
    ['console.warn("w"); console.error("e");', 2],
    ['console\n  .info(x);', 1],
    ["console['error'](err);", 1],
    ['const { log } = console;', 1],
    ['globalThis.console.log(x);', 1],
    ['const c = console; c.log(x);', 1],
  ])('flags %j', (source, count) => {
    expect(findConsoleCalls(source)).toHaveLength(count);
  });

  it.each([
    ['logger.info("x");'],
    ["// console.log('debug');"],
    ["/* console.log('debug'); */"],
    ['const myconsole = { log: () => undefined }; myconsole.log();'],
    ["logger.info('see console.log output');"],
    ['logger.info("console.error is not used");'],
    ['logger.info(`console.log ${id}`);'],
    ["// don't use console.log\nlogger.info('x');"],
  ])('allows %j', (source) => {
    expect(findConsoleCalls(source)).toEqual([]);
  });
});
