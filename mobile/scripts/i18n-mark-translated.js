#!/usr/bin/env node
/**
 * Record that a locale's translation is current with the English it came from (#671).
 *
 * `i18n/translated-from.json` holds, per language code and key, a short hash of
 * the `en.json` value the translation was written from. `__tests__/i18n/locale-parity.test.ts`
 * fails when the English value has changed since (the translation is stale), when a
 * key has no record yet, or when a record names a key that no longer exists.
 *
 * After translating (or re-checking) keys, mark them:
 *   npm run i18n:mark -- es teams.title teams.createNew
 * Mark every key of a language at once only for a brand-new, fully translated file:
 *   npm run i18n:mark -- fr --all
 * Records for keys that no longer exist in en.json are dropped on every run.
 *
 * Marking is the reviewable claim "this translation matches the current English":
 * it shows up in the PR diff next to the locale change.
 */

'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const I18N_DIR = resolve(__dirname, '../i18n');
const LOCALES_DIR = join(I18N_DIR, 'locales');
const RECORD_FILE = join(I18N_DIR, 'translated-from.json');

/** Dot-joined leaf keys mapped to their string values. */
function flatten(tree, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
  }
  return out;
}

/** The hash recorded for an English value. Shared with the parity test. */
function sourceHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function main(argv) {
  const [code, ...rest] = argv;
  if (!code || code === 'en' || rest.length === 0) {
    console.error('Usage: npm run i18n:mark -- <language code> (<key> ... | --all)');
    return 1;
  }
  if (!existsSync(join(LOCALES_DIR, `${code}.json`))) {
    console.error(`No i18n/locales/${code}.json.`);
    return 1;
  }
  const english = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')));
  const translated = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf8')));
  const keys = rest.includes('--all') ? [...english.keys()] : rest;

  const unknown = keys.filter((key) => !english.has(key) || !translated.has(key));
  if (unknown.length > 0) {
    console.error(`Not a key of both en.json and ${code}.json: ${unknown.join(', ')}`);
    return 1;
  }

  const records = existsSync(RECORD_FILE) ? JSON.parse(readFileSync(RECORD_FILE, 'utf8')) : {};
  const current = records[code] ?? {};
  for (const key of keys) current[key] = sourceHash(english.get(key));
  const kept = Object.fromEntries(
    Object.keys(current)
      .filter((key) => english.has(key))
      .sort()
      .map((key) => [key, current[key]]),
  );
  records[code] = kept;
  const sorted = Object.fromEntries(Object.keys(records).sort().map((c) => [c, records[c]]));
  writeFileSync(RECORD_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Marked ${keys.length} key(s) of ${code} as translated from the current English.`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { flatten, sourceHash };
