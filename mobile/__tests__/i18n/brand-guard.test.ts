/**
 * Brand guard (#474).
 *
 * The #431 rename to Hooplings missed `roleOnboarding.title` in en.json, and nothing
 * automated could notice: the screen test stubbed `useTranslation` to return keys, and
 * the Maestro flows that assert the literal only run by hand. This test walks every
 * string value in the locale files and every Maestro flow and fails on a retired brand
 * name, naming the exact location.
 *
 * Scope is deliberately mobile-only: locale JSON + `.maestro/*.yaml`. Backend mailer
 * templates and infra docs are not covered here.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';

/** Names that must never appear in user-facing copy again. */
const RETIRED_BRAND_PATTERNS: RegExp[] = [/capyhoops/i, /basketball tracker/i];

/**
 * Domains that are still live and legitimately contain a retired name. Stripped from
 * each string BEFORE matching, so "capyhoops" anywhere outside these hosts still fails.
 * When the domain moves to hooplings.*, delete the entry here and this guard starts
 * flagging every leftover link. Subdomains (api., mail.) match by suffix.
 */
const ALLOWED_DOMAINS = ['capyhoops.com'];

/** `.maestro/` lives at the repo root, three levels above `mobile/__tests__/i18n/`. */
const MAESTRO_DIR = resolve(__dirname, '../../../.maestro');

interface Offender {
  location: string;
  text: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAllowedDomains(text: string): string {
  return ALLOWED_DOMAINS.reduce(
    (acc, domain) => acc.replace(new RegExp(escapeRegExp(domain), 'gi'), ''),
    text,
  );
}

function findRetiredBrand(text: string): RegExp | undefined {
  const candidate = stripAllowedDomains(text);
  return RETIRED_BRAND_PATTERNS.find((pattern) => pattern.test(candidate));
}

/** Depth-first walk of a parsed locale file, yielding every string leaf with its key path. */
function collectStrings(value: unknown, path: string[], out: { path: string; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ path: path.join('.'), text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, [...path, String(index)], out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, [...path, key], out);
    }
  }
}

function localeOffenders(name: string, locale: unknown): Offender[] {
  const leaves: { path: string; text: string }[] = [];
  collectStrings(locale, [], leaves);
  expect(leaves.length).toBeGreaterThan(0);
  return leaves
    .filter((leaf) => findRetiredBrand(leaf.text))
    .map((leaf) => ({ location: `${name}:${leaf.path}`, text: leaf.text }));
}

function maestroOffenders(): Offender[] {
  const flows = readdirSync(MAESTRO_DIR).filter((file) => /\.ya?ml$/.test(file));
  // A moved or empty directory must fail loudly, never pass vacuously.
  expect(flows.length).toBeGreaterThan(0);
  const offenders: Offender[] = [];
  for (const flow of flows) {
    const lines = readFileSync(join(MAESTRO_DIR, flow), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (findRetiredBrand(line)) {
        offenders.push({ location: `.maestro/${flow}:${index + 1}`, text: line.trim() });
      }
    });
  }
  return offenders;
}

describe('brand guard (#474)', () => {
  it('en.json contains no retired brand name', () => {
    expect(localeOffenders('en.json', en)).toEqual([]);
  });

  it('es.json contains no retired brand name', () => {
    expect(localeOffenders('es.json', es)).toEqual([]);
  });

  it('Maestro flows contain no retired brand name', () => {
    expect(maestroOffenders()).toEqual([]);
  });

  it('still allows the live capyhoops.com domain but nothing else', () => {
    expect(findRetiredBrand('Open https://capyhoops.com/invite/abc')).toBeUndefined();
    expect(findRetiredBrand('api.capyhoops.com')).toBeUndefined();
    expect(findRetiredBrand('How will you use Capyhoops?')).toBeDefined();
    expect(findRetiredBrand('Welcome to Basketball Tracker')).toBeDefined();
  });
});
