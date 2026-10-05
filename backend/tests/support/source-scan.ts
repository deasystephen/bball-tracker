/**
 * Shared helpers for the source-scanning guard tests under `tests/utils/`
 * (`email-match-guard`, `user-write-guard`, `route-catch-log-guard`,
 * `prisma-mock-coverage-guard`). Call them from a `beforeAll`, never at
 * collection time, so `--testPathPattern` runs that skip a guard do not walk
 * the tree.
 */
import { readdirSync } from 'fs';
import path from 'path';

/** Every `.ts` file under `dir`, recursively. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
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
