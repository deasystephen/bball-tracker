/**
 * Shared helpers for the source-scanning guard tests under `tests/utils/`
 * (`email-match-guard`, `user-write-guard`, `route-catch-log-guard`,
 * `no-console-guard`, `stats-rounding-guard`, `prisma-mock-coverage-guard`,
 * `unused-dependencies-guard`) and `tests/services/domain-event-guard`. Call
 * them from a `beforeAll`, never at
 * collection time, so `--testPathPattern` runs that skip a guard do not walk
 * the tree.
 */
import { readdirSync } from 'fs';
import path from 'path';

/** TypeScript plus the plain-JavaScript operator scripts (`scripts/*.mjs`). */
export const SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs'];

/** Every file under `dir` with one of `extensions` (default `.ts`), recursively. */
export function sourceFiles(dir: string, extensions: readonly string[] = ['.ts']): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, extensions);
    return entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

/**
 * Drops block comments, whole-line `//` comments and trailing `//` comments
 * that follow whitespace. `://` in a URL is kept (no whitespace before it).
 * Offsets are not preserved; a guard that needs them masks instead.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/**
 * Replaces every string and template literal with an empty one of the same
 * quote, so a guard does not match text inside a string. Run it after
 * `stripComments` (an apostrophe in a comment would otherwise open a string).
 * A template's `${…}` expressions go with it.
 */
export function stripStrings(source: string): string {
  return source
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}
