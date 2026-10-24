/**
 * Locale parity guard (#732).
 *
 * `i18n/config.ts` renders `es.json` on a Spanish device and falls back to English
 * for any key it lacks, so a key added to `en.json` only shows up as a mixed-language
 * screen and nothing fails. Two PRs did exactly that (17 keys: `roleOnboarding.*` and
 * three `teams.*` keys). This test compares every locale file against `en.json`: the
 * same flattened leaf keys, and the same `{{placeholder}}` names for every shared key,
 * so a translation cannot drop or rename an interpolation variable.
 *
 * It also fails on a value copied from English (#671): a key added to `en.json` and
 * pasted unchanged into another locale passes the key check but ships English to that
 * language. A value with no letters outside its placeholders (`{{count}}`, `#{{n}}`)
 * is exempt; every other identical value must be listed in IDENTICAL_TO_ENGLISH with
 * the reason the word really is the same in that language.
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
 * Values that are legitimately identical to English, per locale file, with the reason.
 * Keep this short: an entry here is a promise that a native speaker would write the
 * English word. Remove an entry when its key goes away (the guard reports stale ones).
 */
const IDENTICAL_TO_ENGLISH: Record<string, Record<string, string>> = {
  'es.json': {
    'common.error': 'Spanish "Error" is spelled the same',
    'common.errorA11y': 'only "Error" plus placeholders',
    'games.statusFinal': 'Spanish "Final" is spelled the same',
    'games.finalBadge': 'Spanish "FINAL" is spelled the same',
    'account.delete.confirmPlaceholder': 'the word the user types stays DELETE; confirmLabel says "Escribe DELETE para confirmar"',
    'stats.abbr.pts': 'PTS is the box-score abbreviation in Spanish too',
    'stats.abbr.reb': 'REB is the box-score abbreviation in Spanish too',
    'stats.abbr.ast': 'AST is the box-score abbreviation in Spanish too',
    'tracker.stat.assistShort': 'AST is the box-score abbreviation in Spanish too',
    'profile.role.ADMIN': 'ADMIN is the role name in Spanish too',
    'about.version': 'the "v" version prefix is the same in Spanish',
  },
};

/** True when a value has a letter outside its `{{placeholders}}`, so it needs translating. */
function hasWords(value: string): boolean {
  return /\p{L}/u.test(value.replace(/\{\{[^}]*\}\}/g, ''));
}

/**
 * Keys whose value is copied from the reference, and allowlist entries that no longer
 * apply (the key is gone or now differs), one readable line each.
 */
function copiedEnglishProblems(
  referenceFlat: FlatLocale,
  localeFlat: FlatLocale,
  allowed: Record<string, string> = {},
): string[] {
  const problems: string[] = [];
  for (const [key, refValue] of referenceFlat.values) {
    const value = localeFlat.values.get(key);
    if (value === undefined || value.trim() !== refValue.trim() || !hasWords(refValue)) continue;
    if (!(key in allowed)) problems.push(`copied from English: ${key} = ${JSON.stringify(value)}`);
  }
  for (const key of Object.keys(allowed)) {
    const value = localeFlat.values.get(key);
    const refValue = referenceFlat.values.get(key);
    if (value === undefined || refValue === undefined || value.trim() !== refValue.trim()) {
      problems.push(`stale IDENTICAL_TO_ENGLISH entry: ${key}`);
    }
  }
  return problems;
}

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
  it.each(otherLocales)('%s translates every value instead of copying the English', (file) => {
    expect(copiedEnglishProblems(reference, loadLocale(file), IDENTICAL_TO_ENGLISH[file])).toEqual([]);
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

  it('names a value copied from English and a stale allowlist entry', () => {
    const en = flattenLocale({ a: 'Save', b: 'Final', c: '{{count}}', d: '#{{n}}', e: 'Gone' });
    const es = flattenLocale({ a: 'Save', b: 'Final', c: '{{count}}', d: '#{{n}}', e: 'Ido' });
    expect(copiedEnglishProblems(en, es, { b: 'same word', e: 'no longer identical', z: 'key removed' })).toEqual([
      'copied from English: a = "Save"',
      'stale IDENTICAL_TO_ENGLISH entry: e',
      'stale IDENTICAL_TO_ENGLISH entry: z',
    ]);
  });

  it('passes a faithful translation, whatever the placeholder order', () => {
    const twoVars = flattenLocale({ x: '{{a}} of {{b}}' });
    expect(parityProblems(twoVars, flattenLocale({ x: '{{b}} de {{a}}' }))).toEqual([]);
    expect(parityProblems(ref, flattenLocale({ a: { b: 'Hola {{name}}', c: 'Adiós' }, d: '{{count}} partidos' }))).toEqual([]);
  });
});
