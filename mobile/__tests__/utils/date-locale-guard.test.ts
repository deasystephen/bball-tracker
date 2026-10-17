/**
 * Guard: no mobile source pins a locale when it formats a date (#769).
 *
 * Nine formatters once passed `'en-US'` to `toLocaleDateString`, so a Spanish
 * or British device saw English month names and a 12-hour clock beside
 * screens that followed the device. Dates and times now go through
 * `utils/format-date.ts`, which resolves the device locale once. This walks
 * every `.ts/.tsx/.js` file under `mobile/` (minus `__tests__`, dependencies
 * and native/build output) and fails on any `toLocaleDateString`,
 * `toLocaleTimeString`, `toLocaleString` or `Intl.DateTimeFormat` call whose
 * first argument is a string literal, such as `'en-US'`.
 *
 * To fix a finding, call the matching `utils/format-date.ts` helper, or pass
 * `deviceLocale()` (or `undefined`) as the locale.
 */

import fs from 'fs';
import path from 'path';

import { MOBILE_ROOT, scanLines } from '../helpers/source-files';

const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  'ios',
  'android',
  '.expo',
  'dist',
  'build',
  'coverage',
  '.git',
]);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const PINNED_LOCALE = /(?:\btoLocale(?:Date|Time)?String|\bIntl\s*\.\s*DateTimeFormat)\s*\(\s*['"`]/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path.join(dir, entry.name));
    return EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path.join(dir, entry.name)] : [];
  });
}

export function findPinnedLocales(fileName: string, text: string): string[] {
  return scanLines(fileName, text, PINNED_LOCALE);
}

describe('dates are formatted in the device locale', () => {
  it('finds no hard-coded locale in mobile source', () => {
    const files = walk(MOBILE_ROOT).map((file) => path.relative(MOBILE_ROOT, file));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(path.join('utils', 'format-date.ts'));

    const findings = files.flatMap((file) =>
      findPinnedLocales(file, fs.readFileSync(path.join(MOBILE_ROOT, file), 'utf8'))
    );

    expect(findings).toEqual([]);
  });

  describe('the scanner', () => {
    it.each([
      "return date.toLocaleDateString('en-US', {",
      "d.toLocaleTimeString('en-US', { hour: 'numeric' })",
      'value.toLocaleString("en-US")',
      'new Intl.DateTimeFormat(`en-GB`, options)',
      "Intl.DateTimeFormat( 'es-ES' ).format(d)",
    ])('reports %s', (line) => {
      expect(findPinnedLocales('sample.tsx', line)).toHaveLength(1);
    });

    it.each([
      'date.toLocaleDateString(undefined, { month: "short" })',
      'date.toLocaleTimeString(deviceLocale(), options)',
      'new Date(publishedAt).toLocaleString()',
      'new Intl.DateTimeFormat(locale, options)',
      'const label = "toLocaleDateString";',
    ])('accepts %s', (line) => {
      expect(findPinnedLocales('sample.tsx', line)).toEqual([]);
    });
  });
});
