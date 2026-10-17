/**
 * Locale parity guard (#732).
 *
 * `i18n/config.ts` renders `es.json` on a Spanish device and falls back to English
 * for any key it lacks, so a key added to `en.json` only shows up as a mixed-language
 * screen and nothing fails. Two PRs did exactly that (17 keys: `roleOnboarding.*` and
 * three `teams.*` keys). This test compares every locale file against `en.json`: the
 * same flattened leaf keys, and the same `{{placeholder}}` names for every shared key,
 * so a translation cannot drop or rename an interpolation variable.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

type LocaleTree = { [key: string]: string | LocaleTree };

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales');
const REFERENCE = 'en.json';

/** Dot-joined leaf keys mapped to their string values. */
function flattenLocale(tree: LocaleTree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(path, value);
    } else {
      for (const [k, v] of flattenLocale(value, path)) out.set(k, v);
    }
  }
  return out;
}

/** The sorted, de-duplicated `{{name}}` interpolation variables in a string. */
function placeholders(value: string): string[] {
  return [...new Set([...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))].sort();
}

/** Every difference between a locale and the reference, one readable line each. */
function parityProblems(reference: Map<string, string>, locale: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const key of reference.keys()) {
    if (!locale.has(key)) problems.push(`missing: ${key}`);
  }
  for (const key of locale.keys()) {
    if (!reference.has(key)) problems.push(`extra: ${key}`);
  }
  for (const [key, refValue] of reference) {
    const value = locale.get(key);
    if (value === undefined) continue;
    const want = placeholders(refValue).join(', ');
    const got = placeholders(value).join(', ');
    if (want !== got) problems.push(`placeholders differ: ${key} (en: [${want}], locale: [${got}])`);
  }
  return problems;
}

function loadLocale(file: string): Map<string, string> {
  return flattenLocale(JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as LocaleTree);
}

const reference = loadLocale(REFERENCE);
const otherLocales = readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith('.json') && file !== REFERENCE)
  .sort();

describe('locale parity', () => {
  it('reads a non-trivial reference and at least one other locale', () => {
    expect(reference.size).toBeGreaterThan(0);
    expect(otherLocales).toContain('es.json');
  });

  it.each(otherLocales)('%s has exactly the keys and placeholders of en.json', (file) => {
    const locale = loadLocale(file);
    expect(locale.size).toBeGreaterThan(0);
    expect(parityProblems(reference, locale)).toEqual([]);
  });
});

describe('locale parity guard self-test', () => {
  const ref = flattenLocale({ a: { b: 'Hi {{name}}', c: 'Bye' }, d: '{{count}} games' });

  it('names a missing key, an extra key and a changed placeholder', () => {
    const drifted = flattenLocale({ a: { b: 'Hola {{nombre}}' }, d: '{{count}} partidos', e: 'extra' });
    expect(parityProblems(ref, drifted)).toEqual([
      'missing: a.c',
      'extra: e',
      'placeholders differ: a.b (en: [name], locale: [nombre])',
    ]);
  });

  it('passes a faithful translation, whatever the placeholder order', () => {
    const twoVars = flattenLocale({ x: '{{a}} of {{b}}' });
    expect(parityProblems(twoVars, flattenLocale({ x: '{{b}} de {{a}}' }))).toEqual([]);
    expect(parityProblems(ref, flattenLocale({ a: { b: 'Hola {{name}}', c: 'Adiós' }, d: '{{count}} partidos' }))).toEqual([]);
  });
});
