/**
 * Brand guard (#474).
 *
 * The #431 rename to Hooplings missed `roleOnboarding.title` in en.json, and nothing
 * automated could notice: the screen test stubbed `useTranslation` to return keys, and
 * the Maestro flows that assert the literal only run by hand. This test walks every
 * string value in the locale files, every line of every Maestro flow, and every line of
 * mobile source (`.ts/.tsx/.js/.json` under `mobile/`, minus native/build dirs and
 * `__tests__`, whose negative fixtures quote the old names) and fails on a retired brand
 * name, naming the exact location.
 *
 * Scope is deliberately mobile-only. Backend mailer templates and infra docs are not
 * covered here. Comment lines are in scope on purpose ("any line" is the documented
 * rule), so a historical note like `# was "Capyhoops"` fails CI; reword it.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';

import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';

/**
 * Names that must never appear in user-facing copy again. Separators are tolerated so
 * "Capy Hoops", "capy-hoops" and "BasketballTracker" fail too. `bball` is deliberately
 * NOT retired: `bball-tracker://` and `com.bballtracker.mobile` are kept identifiers.
 */
const RETIRED_BRAND_PATTERNS: RegExp[] = [/capy[\s_-]*hoops/i, /basketball[\s_-]*tracker/i];

/**
 * Hostnames that are live and would otherwise trip the retired-name patterns. A
 * hostname ending in one of these (with any subdomain prefix, e.g. api.) is stripped
 * from each string BEFORE matching. The match is anchored to hostname boundaries, so
 * "<retired>.community", "<retired>.com.evil" and "not<retired>.com" still fail.
 * The old domain left this list in the 2026-09 domain migration (PR3, #502), so every
 * leftover old-domain link in mobile source, locales or .maestro now fails CI. The
 * current domain contains no retired name, so the list is empty; the allowlist
 * self-test below derives from this array and covers the stripping logic with a
 * synthetic entry.
 */
const ALLOWED_DOMAINS: string[] = [];

const MOBILE_ROOT = resolve(__dirname, '../..');
/** `.maestro/` lives at the repo root, one level above `mobile/`. */
const MAESTRO_DIR = resolve(MOBILE_ROOT, '../.maestro');
/** A flow that must exist; proves the walker found the real directory, not just config.yaml. */
const MAESTRO_ANCHOR_FLOW = 'onboarding-role.yaml';

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;
/** Tests quote retired names as negative fixtures, so `__tests__` is not user-facing surface. */
const SOURCE_SKIP_DIRS = new Set(['node_modules', 'ios', 'android', '.expo', 'dist', 'build', 'coverage', '.git', '__tests__']);
const SOURCE_SKIP_FILES = new Set(['package-lock.json']);

interface Leaf {
  path: string;
  text: string;
}

interface Offender {
  location: string;
  text: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `<any.sub.domains.>domain` only where it stands as a whole hostname (no extra label after it). */
function allowedHostPattern(domain: string): RegExp {
  return new RegExp(`(?<![a-z0-9-])(?:[a-z0-9-]+\\.)*${escapeRegExp(domain)}(?![a-z0-9-]|\\.[a-z0-9])`, 'gi');
}

function stripAllowedDomains(text: string, allowed: readonly string[] = ALLOWED_DOMAINS): string {
  return allowed.reduce((acc, domain) => acc.replace(allowedHostPattern(domain), ''), text);
}

function findRetiredBrand(text: string, allowed: readonly string[] = ALLOWED_DOMAINS): RegExp | undefined {
  const candidate = stripAllowedDomains(text, allowed);
  return RETIRED_BRAND_PATTERNS.find((pattern) => pattern.test(candidate));
}

/** Every string leaf of a parsed locale file with its dotted key path (array indices included). */
function collectStrings(value: unknown, path = ''): Leaf[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => collectStrings(child, path ? `${path}.${key}` : key));
  }
  return [];
}

function localeOffenders(name: string, locale: unknown): Offender[] {
  return collectStrings(locale)
    .filter((leaf) => findRetiredBrand(leaf.text))
    .map((leaf) => ({ location: `${name}:${leaf.path}`, text: leaf.text }));
}

/** Depth-first file list under `root`, relative paths, skipping the named directories. */
function walkFiles(root: string, skipDirs: Set<string>): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!skipDirs.has(entry)) visit(full);
      } else {
        out.push(relative(root, full));
      }
    }
  };
  visit(root);
  return out.sort();
}

/** Line-by-line scan of the given files; `label` prefixes each reported location. */
function lineOffenders(root: string, files: string[], label: string): Offender[] {
  const offenders: Offender[] = [];
  for (const file of files) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (findRetiredBrand(line)) {
          offenders.push({ location: `${label}/${file}:${index + 1}`, text: line.trim() });
        }
      });
  }
  return offenders;
}

function maestroFlows(dir: string): string[] {
  return walkFiles(dir, new Set()).filter((file) => /\.ya?ml$/.test(file));
}

function mobileSourceFiles(): string[] {
  const self = relative(MOBILE_ROOT, __filename);
  return walkFiles(MOBILE_ROOT, SOURCE_SKIP_DIRS).filter(
    (file) => SOURCE_EXTENSIONS.test(file) && !SOURCE_SKIP_FILES.has(file.split('/').pop() ?? '') && file !== self,
  );
}

describe('brand guard (#474)', () => {
  it('en.json contains no retired brand name', () => {
    expect(collectStrings(en).length).toBeGreaterThan(0);
    expect(localeOffenders('en.json', en)).toEqual([]);
  });

  it('es.json contains no retired brand name', () => {
    expect(collectStrings(es).length).toBeGreaterThan(0);
    expect(localeOffenders('es.json', es)).toEqual([]);
  });

  it('Maestro flows contain no retired brand name', () => {
    const flows = maestroFlows(MAESTRO_DIR);
    // config.yaml alone must never satisfy this: a moved flow directory fails loudly.
    expect(flows).toContain(MAESTRO_ANCHOR_FLOW);
    expect(flows.filter((file) => file !== 'config.yaml').length).toBeGreaterThan(1);
    expect(lineOffenders(MAESTRO_DIR, flows, '.maestro')).toEqual([]);
  });

  it('mobile source contains no retired brand name', () => {
    const files = mobileSourceFiles();
    expect(files).toContain('app/login.tsx');
    expect(files).not.toContain(relative(MOBILE_ROOT, __filename));
    expect(lineOffenders(MOBILE_ROOT, files, 'mobile')).toEqual([]);
  });

  it('allows an allowlisted domain as a hostname but nothing that merely contains it', () => {
    // Synthetic allowlist: a hostname built from a retired name, so the stripping
    // logic stays covered now that the real list is empty.
    const domain = 'capyhoops.com';
    const allowed = [domain];
    expect(findRetiredBrand(`Open https://${domain}/invite/abc`, allowed)).toBeUndefined();
    expect(findRetiredBrand(`api.${domain}`, allowed)).toBeUndefined();
    expect(findRetiredBrand(`applinks:${domain}`, allowed)).toBeUndefined();
    expect(findRetiredBrand(`${domain}munity`, allowed)).toBeDefined();
    expect(findRetiredBrand(`https://${domain}.evil/x`, allowed)).toBeDefined();
    expect(findRetiredBrand(`not${domain}`, allowed)).toBeDefined();
  });

  it('flags the retired domain itself now that it left the allowlist (2026-09 migration)', () => {
    expect(ALLOWED_DOMAINS).toEqual([]);
    expect(findRetiredBrand('Open https://capyhoops.com/invite/abc')).toBeDefined();
    expect(findRetiredBrand('api.capyhoops.com')).toBeDefined();
    expect(findRetiredBrand('applinks:capyhoops.com')).toBeDefined();
    expect(findRetiredBrand('https://api.hooplings.com/api/v1')).toBeUndefined();
    expect(findRetiredBrand('applinks:hooplings.com')).toBeUndefined();
  });

  it('rejects retired names with any separator', () => {
    for (const text of [
      'How will you use Capyhoops?',
      'Capy Hoops',
      'capy-hoops',
      'Welcome to Basketball Tracker',
      'BasketballTracker',
      'Basketball_Tracker',
    ]) {
      expect(findRetiredBrand(text)).toBeDefined();
    }
    expect(findRetiredBrand('bball-tracker://auth/callback')).toBeUndefined();
    expect(findRetiredBrand('com.bballtracker.mobile')).toBeUndefined();
    expect(findRetiredBrand('Hooplings')).toBeUndefined();
  });

  it('reports a nested or array offender with its key path', () => {
    const fixture = { a: { b: ['fine', 'Welcome to Capyhoops'] }, c: 'Visit https://capyhoops.com', d: 3 };
    expect(localeOffenders('fixture', fixture)).toEqual([
      { location: 'fixture:a.b.1', text: 'Welcome to Capyhoops' },
      // the old domain is no longer allowlisted (2026-09 migration), so a link to it is an offender too
      { location: 'fixture:c', text: 'Visit https://capyhoops.com' },
    ]);
  });

  it('reports a flow offender by file and 1-based line, including nested directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-guard-'));
    try {
      writeFileSync(join(dir, 'clean.yaml'), 'appId: com.bballtracker.mobile\n- assertVisible: "Hooplings"\n');
      writeFileSync(join(dir, 'x.yaml'), 'appId: x\n- assertVisible: "How will you use Capyhoops?"\n');
      const sub = join(dir, 'subflows');
      writeFileSync(join(dir, 'notes.txt'), 'Capyhoops here is ignored: not a flow\n');
      mkdirSync(sub);
      writeFileSync(join(sub, 'nested.yml'), '# was Basketball Tracker\n');
      const flows = maestroFlows(dir);
      expect(flows).toEqual(['clean.yaml', 'subflows/nested.yml', 'x.yaml']);
      expect(lineOffenders(dir, flows, '.maestro')).toEqual([
        { location: '.maestro/subflows/nested.yml:1', text: '# was Basketball Tracker' },
        { location: '.maestro/x.yaml:2', text: '- assertVisible: "How will you use Capyhoops?"' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
