/**
 * Guard for #684: no `console.*` in `src/` outside `utils/logger.ts`.
 *
 * Production logging is one JSON object per line from `utils/logger.ts`,
 * gated by `LOG_LEVEL`, carrying `requestId` / `userId` from the request
 * context (docs/architecture/backend-services.md#logging). A bare console
 * call bypasses all of it, and `utils/redact.ts` / `hashRecipient()` too.
 * ESLint `no-console` (with one override for `src/utils/logger.ts`) is the
 * first line; this suite is the second, and keeps the exception explicit.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { sourceFiles, stripComments } from '../support/source-scan';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');
const LOGGER = path.join(SRC, 'utils/logger.ts');

const CONSOLE_CALL = /\bconsole\s*\.\s*\w+/g;

export function findConsoleCalls(source: string): string[] {
  return stripComments(source).match(CONSOLE_CALL) ?? [];
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
  ])('flags %j', (source, count) => {
    expect(findConsoleCalls(source)).toHaveLength(count);
  });

  it.each([
    ['logger.info("x");'],
    ["// console.log('debug');"],
    ["/* console.log('debug'); */"],
    ['const myconsole = { log: () => undefined }; myconsole.log();'],
  ])('allows %j', (source) => {
    expect(findConsoleCalls(source)).toEqual([]);
  });
});
