/**
 * Guard: no lint suppression comments anywhere in the three packages (#1127).
 *
 * `CLAUDE.md` (Code Style) forbids suppressing a lint error and names the one
 * exception: the `no-namespace` disable on a `declare global { namespace
 * Express }` augmentation. `--max-warnings 0` cannot see a suppressed rule, so
 * this reads the source.
 *
 * It lives in the mobile suite although it scans backend and web too: this job
 * runs on every PR, and a change here does not start an API deploy.
 */

import fs from 'fs';
import path from 'path';

import { scanLines, walkFiles } from '../helpers/source-files';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PACKAGES = ['backend', 'mobile', 'web'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'ios',
  'android',
  '.expo',
  '.next',
  'dist',
  'build',
  'coverage',
  '.git',
]);

// A comment opener followed directly by the directive. Prose that mentions the
// rule ("no blanket … suppressions") has words in between and does not match.
const DIRECTIVE = new RegExp(`(//|/\\*)\\s*eslint-${'disable'}`);

/** The exception `CLAUDE.md` names, as `<file>` → the only rule it may disable. */
const ALLOWED: Record<string, string> = {
  'backend/src/api/auth/middleware.ts': '@typescript-eslint/no-namespace',
  'backend/src/api/middleware/request-context.ts': '@typescript-eslint/no-namespace',
};

function findings(): string[] {
  return PACKAGES.flatMap((pkg) =>
    walkFiles(path.join(REPO_ROOT, pkg), SKIP_DIRS)
      .filter((file) => EXTENSIONS.some((ext) => file.endsWith(ext)))
      .flatMap((file) => {
        const relative = `${pkg}/${file.split(path.sep).join('/')}`;
        return scanLines(relative, fs.readFileSync(path.join(REPO_ROOT, pkg, file), 'utf8'), DIRECTIVE);
      }),
  );
}

describe('lint suppressions', () => {
  const found = findings();

  it('appear only in the two Express namespace augmentations', () => {
    const unexpected = found.filter((line) => {
      const file = line.slice(0, line.indexOf(':'));
      const allowedRule = ALLOWED[file];
      return !allowedRule || !line.endsWith(`-next-line ${allowedRule}`);
    });
    expect(unexpected).toEqual([]);
  });

  it('still finds the two allowed ones, so the scan is not silently empty', () => {
    expect(found.map((line) => line.slice(0, line.indexOf(':'))).sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
