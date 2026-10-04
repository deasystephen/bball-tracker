/**
 * Shared plumbing for the source-scanning guard tests: walk a directory for
 * source files and report the lines that match a pattern. Not a test file
 * (Jest only collects `*.test.ts(x)`).
 */

import fs from 'fs';
import path from 'path';

/** The `mobile/` package root. */
export const MOBILE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Absolute paths of every file under `dir` (recursively) whose name ends in
 * one of `extensions`. Throws when `dir` does not exist, so a guard never
 * scans nothing without noticing.
 */
export function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

/** Every line of `text` matching `pattern`, as `<fileName>:<line> <trimmed text>`. */
export function scanLines(fileName: string, text: string, pattern: RegExp): string[] {
  return text
    .split('\n')
    .flatMap((line, index) => (pattern.test(line) ? [`${fileName}:${index + 1} ${line.trim()}`] : []));
}
