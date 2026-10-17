/**
 * Guard for #572: no case-insensitive EQUALITY filter is written by hand.
 *
 * Prisma compiles `{ equals, mode: 'insensitive' }` to ILIKE with the value
 * as an unescaped pattern, so `_` and `%` in an email are wildcards and the
 * lookup can return somebody else's account. `emailEquals` in
 * `src/utils/email-match.ts` escapes them; this suite fails on any other
 * place in `src/` or `scripts/` (TypeScript and the `.js` / `.mjs` scripts)
 * whose innermost object literal holds `equals` together with ANY explicit
 * `mode` (`mode: 'insensitive'`, `mode: Prisma.QueryMode.insensitive`,
 * `mode: SOME_CONSTANT`, shorthand `mode`). Outside `emailEquals` there is no
 * legitimate reason to pair `equals` with a `mode`, so the value is not
 * inspected (#696). `scripts/` holds the operator CLI that runs against
 * production in `operator` mode (#648): the one place where a wrong row is
 * exported or deleted with no owner check in the way. Not checked: a filter
 * object built in pieces (`{ ...base, mode }` across statements), and
 * `startsWith` / `endsWith` + insensitive (no such call site on an address).
 *
 * `contains` + `mode: 'insensitive'` is allowed: search is meant to be loose.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { SCRIPT_EXTENSIONS, sourceFiles, stripComments } from '../support/source-scan';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');
const SCRIPTS = path.join(BACKEND, 'scripts');
const HELPER = path.join(SRC, 'utils/email-match.ts');
const OPERATOR_CLI = path.join(SCRIPTS, 'data-subject-request.ts');
const MJS_SCRIPT = path.join(SCRIPTS, 'pg-upgrade-checks.mjs');

/**
 * An innermost `{ … }` (no nested braces) that holds both `equals` and an
 * explicit `mode` (any value, or the shorthand), in either order, on one line
 * or across several.
 */
const RAW_INSENSITIVE_EQUALS = /\{(?=[^{}]*\bequals\b)(?=[^{}]*\bmode\s*[:,}])[^{}]*\}/g;

export function findRawInsensitiveEquals(source: string): string[] {
  return stripComments(source).match(RAW_INSENSITIVE_EQUALS) ?? [];
}

describe('case-insensitive equality goes through emailEquals (#572)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = [...sourceFiles(SRC), ...sourceFiles(SCRIPTS, SCRIPT_EXTENSIONS)];
  });

  it('scans the backend source and the operator scripts', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(HELPER);
    expect(files).toContain(OPERATOR_CLI);
    expect(files).toContain(MJS_SCRIPT);
  });

  it('finds no hand-written equals + insensitive filter outside the helper', () => {
    const offenders = files
      .filter((file) => file !== HELPER)
      .flatMap((file) =>
        findRawInsensitiveEquals(readFileSync(file, 'utf8')).map(
          (match) => `${path.relative(BACKEND, file)}: ${match.replace(/\s+/g, ' ')}`
        )
      );

    expect(offenders).toEqual([]);
  });

  it('the helper itself is where the filter is built', () => {
    // Its type and its return value; proof the pattern sees real source.
    expect(findRawInsensitiveEquals(readFileSync(HELPER, 'utf8')).length).toBeGreaterThan(0);
  });
});

describe('the guard pattern', () => {
  it.each([
    ["where: { email: { equals: email, mode: 'insensitive' } }", 1],
    ["where: { email: { mode: 'insensitive', equals: email } }", 1],
    ['where: { invitedEmail: { equals: user.email, mode: "insensitive" } }', 1],
    ["{ email: {\n  equals: address,\n  mode: 'insensitive',\n} }", 1],
    ["[{ a: { equals: x, mode: 'insensitive' } }, { b: { equals: y, mode: 'insensitive' } }]", 2],
    ['where: { email: { equals: email, mode: Prisma.QueryMode.insensitive } }', 1],
    ['where: { email: { mode: QueryMode.insensitive, equals: email } }', 1],
    ['{ email: {\n  equals: address,\n  mode: Prisma.QueryMode.insensitive,\n} }', 1],
    ['where: { email: { equals: email, mode: INSENSITIVE } }', 1],
    ['where: { email: { equals: email, mode } }', 1],
    ['where: { email: { mode, equals: email } }', 1],
    ['where: { email: { equals: email, mode: Prisma.QueryMode.default } }', 1],
  ])('flags %j', (source, count) => {
    expect(findRawInsensitiveEquals(source)).toHaveLength(count);
  });

  it.each([
    ["where: { email: emailEquals(email) }"],
    ["{ name: { contains: search, mode: 'insensitive' } }"],
    ['{ name: { contains: search, mode: Prisma.QueryMode.insensitive } }'],
    ['{ email: { equals: email }, modeOfPlay: x }'],
    ["{ email: { equals: email } }"],
    ["// where: { email: { equals: email, mode: 'insensitive' } }"],
    ["/* { equals: a, mode: 'insensitive' } */"],
  ])('allows %j', (source) => {
    expect(findRawInsensitiveEquals(source)).toEqual([]);
  });
});
