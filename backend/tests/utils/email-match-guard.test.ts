/**
 * Guard for #572: no case-insensitive EQUALITY filter is written by hand.
 *
 * Prisma compiles `{ equals, mode: 'insensitive' }` to ILIKE with the value
 * as an unescaped pattern, so `_` and `%` in an email are wildcards and the
 * lookup can return somebody else's account. `emailEquals` in
 * `src/utils/email-match.ts` escapes them; this suite fails on any other
 * place in `src/` that builds that filter itself.
 *
 * `contains` + `mode: 'insensitive'` is allowed: search is meant to be loose.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');
const HELPER = path.join(SRC, 'utils/email-match.ts');

/**
 * An innermost `{ … }` (no nested braces) that holds both `equals` and
 * `mode: 'insensitive'`, in either order, on one line or across several.
 */
const RAW_INSENSITIVE_EQUALS =
  /\{(?=[^{}]*\bequals\b)(?=[^{}]*\bmode\s*:\s*['"]insensitive['"])[^{}]*\}/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

export function findRawInsensitiveEquals(source: string): string[] {
  return stripComments(source).match(RAW_INSENSITIVE_EQUALS) ?? [];
}

describe('case-insensitive equality goes through emailEquals (#572)', () => {
  const files = sourceFiles(SRC);

  it('scans the backend source', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(HELPER);
  });

  it('finds no hand-written equals + insensitive filter outside the helper', () => {
    const offenders = files
      .filter((file) => file !== HELPER)
      .flatMap((file) =>
        findRawInsensitiveEquals(readFileSync(file, 'utf8')).map(
          (match) => `${path.relative(SRC, file)}: ${match.replace(/\s+/g, ' ')}`
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
  ])('flags %j', (source, count) => {
    expect(findRawInsensitiveEquals(source)).toHaveLength(count);
  });

  it.each([
    ["where: { email: emailEquals(email) }"],
    ["{ name: { contains: search, mode: 'insensitive' } }"],
    ["{ email: { equals: email } }"],
    ["// where: { email: { equals: email, mode: 'insensitive' } }"],
    ["/* { equals: a, mode: 'insensitive' } */"],
  ])('allows %j', (source) => {
    expect(findRawInsensitiveEquals(source)).toEqual([]);
  });
});
