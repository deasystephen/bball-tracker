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
 * Two more checks keep every language current (#671):
 *  - Copied English: a key added to `en.json` and pasted unchanged (any letter case)
 *    into another locale passes the key check but ships English. A value with no
 *    letters outside its placeholders is exempt; every other identical value must be
 *    listed in IDENTICAL_TO_ENGLISH with the reason the word really is the same. It
 *    cannot see a value that is only partly translated.
 *  - Stale translation: `i18n/translated-from.json` records, per language and key, a
 *    hash of the English each translation was written from. Changing an English value
 *    fails here until the translation is updated and re-marked with
 *    `npm run i18n:mark -- <code> <key>…` (`scripts/i18n-mark-translated.js`).
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

type LocaleTree = { [key: string]: unknown };

/** Leaf keys mapped to their string values, plus every leaf that is not a string. */
interface FlatLocale {
  values: Map<string, string>;
  nonStringLeaves: string[];
}

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales');
const RECORD_FILE = resolve(__dirname, '../../i18n/translated-from.json');
const REFERENCE = 'en.json';

/**
 * Values that are legitimately identical to English, per locale file, with the reason.
 * Keep this short: an entry here is a promise that a native speaker would write the
 * English word. Remove an entry when its key goes away (the guard reports stale ones).
 */
const IDENTICAL_TO_ENGLISH: Record<string, Record<string, string>> = {
  es: {
    'common.error': 'Spanish "Error" is spelled the same',
    'common.errorA11y': 'only "Error" plus placeholders',
    'games.statusFinal': 'Spanish "Final" is spelled the same',
    'games.finalBadge': 'Spanish "FINAL" is spelled the same',
    'stats.abbr.pts': 'PTS is the box-score abbreviation in Spanish too',
    'stats.abbr.reb': 'REB is the box-score abbreviation in Spanish too',
    'stats.abbr.ast': 'AST appears in Spanish-language box scores too; on the native-speaker review list (#671)',
    'tracker.stat.assistShort': 'AST appears in Spanish-language box scores too; on the native-speaker review list (#671)',
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
  const same = (a: string, b: string) => a.trim().toLocaleLowerCase('en') === b.trim().toLocaleLowerCase('en');
  for (const [key, refValue] of referenceFlat.values) {
    const value = localeFlat.values.get(key);
    if (value === undefined || !same(value, refValue) || !hasWords(refValue)) continue;
    if (!(key in allowed)) problems.push(`copied from English: ${key} = ${JSON.stringify(value)}`);
  }
  for (const key of Object.keys(allowed)) {
    const value = localeFlat.values.get(key);
    const refValue = referenceFlat.values.get(key);
    if (value === undefined || refValue === undefined || !same(value, refValue) || !hasWords(refValue)) {
      problems.push(`stale IDENTICAL_TO_ENGLISH entry: ${key}`);
    }
  }
  return problems;
}

/**
 * The hash `scripts/i18n-mark-translated.js#sourceHash` records. The self-test below
 * runs the script's own function and fails if the two ever differ.
 */
function sourceHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Keys whose English changed since the translation was marked, keys never marked, and
 * records for keys that no longer exist, one readable line each, with the fix.
 */
function staleTranslationProblems(code: string, referenceFlat: FlatLocale, records: Record<string, string> = {}): string[] {
  const problems: string[] = [];
  for (const [key, refValue] of referenceFlat.values) {
    const recorded = records[key];
    if (recorded === undefined) {
      problems.push(`not marked translated: ${key} (translate it, then npm run i18n:mark -- ${code} ${key})`);
    } else if (recorded !== sourceHash(refValue)) {
      problems.push(`English changed since translated: ${key} (update ${code}.json, then npm run i18n:mark -- ${code} ${key})`);
    }
  }
  for (const key of Object.keys(records)) {
    if (!referenceFlat.values.has(key)) problems.push(`record for a removed key: ${key} (npm run i18n:mark -- ${code} <any key> drops it)`);
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
const codeOf = (file: string) => file.replace(/\.json$/, '');
const records = JSON.parse(readFileSync(RECORD_FILE, 'utf8')) as Record<string, Record<string, string>>;

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
    expect(copiedEnglishProblems(reference, loadLocale(file), IDENTICAL_TO_ENGLISH[codeOf(file)])).toEqual([]);
  });

  it.each(otherLocales)('%s is current with every English value it was translated from', (file) => {
    expect(staleTranslationProblems(codeOf(file), reference, records[codeOf(file)])).toEqual([]);
  });

  it('keeps allowlists and records only for languages that exist', () => {
    const codes = otherLocales.map(codeOf);
    expect(Object.keys(IDENTICAL_TO_ENGLISH).filter((code) => !codes.includes(code))).toEqual([]);
    expect(Object.keys(records).filter((code) => !codes.includes(code))).toEqual([]);
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

  it('treats a case-changed copy as copied, and an allowlisted value with no letters as stale', () => {
    const en = flattenLocale({ a: 'Add Player', v: '{{version}}' });
    const es = flattenLocale({ a: 'add player', v: '{{version}}' });
    expect(copiedEnglishProblems(en, es, { v: 'version prefix' })).toEqual([
      'copied from English: a = "add player"',
      'stale IDENTICAL_TO_ENGLISH entry: v',
    ]);
  });

  it('hashes English values exactly as scripts/i18n-mark-translated.js does', () => {
    const script = resolve(__dirname, '../../scripts/i18n-mark-translated.js');
    const sample = 'Type {{word}} to confirm — ñ';
    const fromScript = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(require(process.argv[1]).sourceHash(process.argv[2]))', script, sample],
      { encoding: 'utf8' },
    );
    expect(fromScript).toBe(sourceHash(sample));
  });

  it('names a stale, an unmarked and a removed translation record', () => {
    const en = flattenLocale({ a: 'Invite player', b: 'Save', c: 'New' });
    const marked = { a: sourceHash('Add player'), b: sourceHash('Save'), gone: sourceHash('Old') };
    expect(staleTranslationProblems('es', en, marked)).toEqual([
      'English changed since translated: a (update es.json, then npm run i18n:mark -- es a)',
      'not marked translated: c (translate it, then npm run i18n:mark -- es c)',
      'record for a removed key: gone (npm run i18n:mark -- es <any key> drops it)',
    ]);
  });

  it('passes a faithful translation, whatever the placeholder order', () => {
    const twoVars = flattenLocale({ x: '{{a}} of {{b}}' });
    expect(parityProblems(twoVars, flattenLocale({ x: '{{b}} de {{a}}' }))).toEqual([]);
    expect(parityProblems(ref, flattenLocale({ a: { b: 'Hola {{name}}', c: 'Adiós' }, d: '{{count}} partidos' }))).toEqual([]);
  });
});
