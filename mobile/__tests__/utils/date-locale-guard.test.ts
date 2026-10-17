/**
 * Guard: every date or time string goes through `utils/format-date.ts` (#769).
 *
 * Nine formatters once passed `'en-US'` while other screens passed nothing,
 * so a Spanish or British device saw two date formats on adjacent screens.
 * `utils/format-date.ts` now owns the one locale source (the device's full
 * language tag). This parses every `.ts/.tsx/.js` file under `mobile/` (minus
 * `__tests__`, dependencies and native/build output) and fails on any call to
 * `.toLocaleDateString(`, `.toLocaleTimeString(`, `.toLocaleString(` or
 * `Intl.DateTimeFormat(` (with or without `new`) outside the helper. Calls are
 * found on the syntax tree, so a Prettier-wrapped call cannot slip through
 * and a string that merely names a method is not a call.
 *
 * `toLocaleString` is also how numbers are formatted; none does today. If a
 * number ever needs it, give it a helper in `utils/format-date.ts` (or a
 * sibling allowed here) so the locale still has one source.
 *
 * To fix a finding, call the matching helper (`formatShortDate`,
 * `formatLongDate`, `formatCalendarDate`, `formatSeasonDate`,
 * `formatMonthDay`, `formatMonthShort`, `formatNumericDate`,
 * `formatDateTime`, `formatClockTime`), or add a shape there.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, SOURCE_SKIP_DIRS, lineOf, parseTsx, walkFiles } from '../helpers/source-files';

const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ALLOWED = new Set([path.join('utils', 'format-date.ts')]);
const LOCALE_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']);

function isIntlDateTimeFormat(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'DateTimeFormat' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Intl'
  );
}

/** Every date-formatting call in `text`, as `<fileName>:<line> <call head>`. */
export function findDateFormatCalls(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const isLocaleMethod = ts.isPropertyAccessExpression(callee) && LOCALE_METHODS.has(callee.name.text);
      if (isLocaleMethod || isIntlDateTimeFormat(callee)) {
        const head = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
        findings.push(`${fileName}:${lineOf(source, node)} ${head}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('every date or time string goes through utils/format-date.ts', () => {
  it('finds no date-formatting call outside the helper', () => {
    const files = walkFiles(MOBILE_ROOT, SOURCE_SKIP_DIRS).filter((file) => EXTENSIONS.test(file));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(path.join('utils', 'format-date.ts'));
    // The helper itself must be visible to the scanner, or the allowlist hides nothing.
    expect(
      findDateFormatCalls('format-date.ts', fs.readFileSync(path.join(MOBILE_ROOT, 'utils', 'format-date.ts'), 'utf8'))
        .length
    ).toBeGreaterThan(0);

    const findings = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => findDateFormatCalls(file, fs.readFileSync(path.join(MOBILE_ROOT, file), 'utf8')));

    expect(findings).toEqual([]);
  });

  describe('the scanner', () => {
    it.each([
      "return date.toLocaleDateString('en-US', { month: 'short' });",
      "d.toLocaleTimeString(undefined, { hour: 'numeric' })",
      'new Date(publishedAt).toLocaleString()',
      'value?.toLocaleDateString()',
      'new Intl.DateTimeFormat(`en-GB`, options)',
      "Intl.DateTimeFormat('es-ES').format(d)",
      "date.toLocaleDateString(\n  'en-US',\n  { month: 'long' }\n)",
    ])('reports %j', (snippet) => {
      expect(findDateFormatCalls('sample.tsx', snippet)).toHaveLength(1);
    });

    it.each([
      'formatLongDate(game.date)',
      'formatClockTime(item.timestamp, { seconds: true })',
      'const label = "toLocaleDateString(\'en-US\')";',
      '// date.toLocaleDateString()',
      'const fn = date.toLocaleDateString;',
      'new Intl.NumberFormat(locale)',
    ])('accepts %j', (snippet) => {
      expect(findDateFormatCalls('sample.tsx', snippet)).toEqual([]);
    });
  });
});
