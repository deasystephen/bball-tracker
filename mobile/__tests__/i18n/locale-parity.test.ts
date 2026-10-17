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

type LocaleTree = { [key: string]: unknown };

/** Leaf keys mapped to their string values, plus every leaf that is not a string. */
interface FlatLocale {
  values: Map<string, string>;
  nonStringLeaves: string[];
}

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales');
const REFERENCE = 'en.json';

/**
 * Dot-joined leaf keys mapped to their string values. Only a non-null object is a
 * subtree; a number, boolean, null or array leaf is recorded by key, so it is reported
 * instead of vanishing from both key sets or throwing without a name.
 */
function flattenLocale(tree: LocaleTree, prefix = '', out: FlatLocale = { values: new Map(), nonStringLeaves: [] }): FlatLocale {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.values.set(path, value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      flattenLocale(value as LocaleTree, path, out);
    } else {
      out.nonStringLeaves.push(path);
    }
  }
  return out;
}

/**
 * The sorted, de-duplicated interpolation variable names in a string. i18next format
 * syntax counts by its name: `{{count, number}}` is `count`.
 */
function placeholders(value: string): string[] {
  const names = [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].split(',')[0].trim());
  return [...new Set(names)].sort();
}

/** Every difference between a locale and the reference, one readable line each. */
function parityProblems(referenceFlat: FlatLocale, localeFlat: FlatLocale): string[] {
  const reference = referenceFlat.values;
  const locale = localeFlat.values;
  const problems: string[] = [
    ...referenceFlat.nonStringLeaves.map((key) => `non-string leaf in en: ${key}`),
    ...localeFlat.nonStringLeaves.map((key) => `non-string leaf: ${key}`),
  ];
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

function loadLocale(file: string): FlatLocale {
  return flattenLocale(JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as LocaleTree);
}

const reference = loadLocale(REFERENCE);
const otherLocales = readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith('.json') && file !== REFERENCE)
  .sort();

describe('locale parity', () => {
  it('reads a non-trivial reference and at least one other locale', () => {
    expect(reference.values.size).toBeGreaterThan(0);
    expect(otherLocales).toContain('es.json');
  });

  it.each(otherLocales)('%s has exactly the keys and placeholders of en.json', (file) => {
    const locale = loadLocale(file);
    expect(locale.values.size).toBeGreaterThan(0);
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

  it('names a non-string leaf instead of dropping it or throwing', () => {
    const drifted = flattenLocale({ a: { b: 'Hola {{name}}', c: 3 }, d: null, e: true });
    expect(parityProblems(ref, drifted)).toEqual([
      'non-string leaf: a.c',
      'non-string leaf: d',
      'non-string leaf: e',
      'missing: a.c',
      'missing: d',
    ]);
  });

  it('reads i18next format syntax by its variable name', () => {
    const formatted = flattenLocale({ x: '{{count, number}} games on {{date, datetime}}' });
    expect(parityProblems(formatted, flattenLocale({ x: '{{ count,number }} partidos el {{date, datetime}}' }))).toEqual([]);
    expect(parityProblems(formatted, flattenLocale({ x: '{{total, number}} partidos el {{date, datetime}}' }))).toEqual([
      'placeholders differ: x (en: [count, date], locale: [date, total])',
    ]);
  });

  it('passes a faithful translation, whatever the placeholder order', () => {
    const twoVars = flattenLocale({ x: '{{a}} of {{b}}' });
    expect(parityProblems(twoVars, flattenLocale({ x: '{{b}} de {{a}}' }))).toEqual([]);
    expect(parityProblems(ref, flattenLocale({ a: { b: 'Hola {{name}}', c: 'Adiós' }, d: '{{count}} partidos' }))).toEqual([]);
  });
});
