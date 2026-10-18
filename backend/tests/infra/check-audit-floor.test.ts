/**
 * The audit floor gate (`.github/scripts/check-audit-floor.mjs`, #924) that CI and the daily
 * upgrade scan run from each package directory. It parses `npm audit --omit=dev --json` and fails
 * on a high or critical advisory the side has not accepted in `.github/scripts/accepted-advisories.json`.
 *
 * Every test feeds a saved report through `--report` and its own allow-list through
 * `ACCEPTED_ADVISORIES_FILE`, from a temp directory named after the side, so nothing here calls the
 * network or moves when the real list changes. The report shape below is what npm 11 prints; the
 * deepmerge-ts entry is the one the #919 lockfile (a767dc1) produced.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/check-audit-floor.mjs');
const REAL_ALLOW_FILE = path.join(ROOT, '.github/scripts/accepted-advisories.json');

type Advisory = {
  source: number;
  name: string;
  dependency: string;
  title: string;
  url: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  range: string;
};
type AllowEntry = { ghsa: string; package: string; why: string; revisit: string };

function advisory(name: string, ghsa: string, severity: Advisory['severity'], range: string): Advisory {
  return {
    source: 1000000 + name.length,
    name,
    dependency: name,
    title: `${name} fixture advisory`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range,
  };
}

const DEEPMERGE = advisory('deepmerge-ts', 'GHSA-ggr8-5vv4-36mx', 'high', '<8.0.0');
const BRACES = advisory('braces', 'GHSA-vfj7-8cjw-p6xm', 'high', '<=3.0.3');
const CRITICAL = advisory('evil-pkg', 'GHSA-crit-0000-0000', 'critical', '<2.0.0');
const SPRINTF = advisory('sprintf-js', 'GHSA-hp3w-g68c-fv3c', 'moderate', '<=1.1.3');

/** An `npm audit --json` report: each advisory's package, plus one parent that only points at it. */
function report(advisories: Advisory[]): object {
  const vulnerabilities: Record<string, object> = {};
  for (const a of advisories) {
    vulnerabilities[a.name] = { name: a.name, severity: a.severity, isDirect: false, via: [a], effects: [`parent-of-${a.name}`], range: a.range, nodes: [`node_modules/${a.name}`], fixAvailable: false };
    vulnerabilities[`parent-of-${a.name}`] = { name: `parent-of-${a.name}`, severity: a.severity, isDirect: true, via: [a.name], effects: [], range: '*', nodes: [`node_modules/parent-of-${a.name}`], fixAvailable: false };
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } };
}

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function gate(
  side: string,
  auditReport: object | string,
  allow: Record<string, AllowEntry[]> = {},
): { status: number; stdout: string; stderr: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-floor-'));
  tempRoots.push(root);
  const dir = path.join(root, side);
  mkdirSync(dir);
  const reportFile = path.join(root, 'audit.json');
  writeFileSync(reportFile, typeof auditReport === 'string' ? auditReport : JSON.stringify(auditReport));
  const allowFile = path.join(root, 'accepted-advisories.json');
  writeFileSync(allowFile, JSON.stringify({ _doc: 'fixture', backend: [], web: [], mobile: [], ...allow }));
  const env = { ...process.env, ACCEPTED_ADVISORIES_FILE: allowFile };
  try {
    const stdout = execFileSync('node', [SCRIPT, '--report', reportFile], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, stdout: String(failed.stdout), stderr: String(failed.stderr) };
  }
}

const accept = (a: Advisory): AllowEntry => ({ ghsa: a.url.split('/').pop() as string, package: a.name, why: 'fixture', revisit: 'fixture' });

describe('accepted-advisories.json (the real list)', () => {
  it('is keyed by the three package directories and every entry names its GHSA, package, reason and revisit condition', () => {
    const list = JSON.parse(readFileSync(REAL_ALLOW_FILE, 'utf8')) as Record<string, AllowEntry[] | string>;
    const sides = Object.keys(list).filter((key) => !key.startsWith('_'));
    expect(sides.sort()).toEqual(['backend', 'mobile', 'web']);
    for (const side of sides) {
      for (const entry of list[side] as AllowEntry[]) {
        expect(entry).toEqual({
          ghsa: expect.stringMatching(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/),
          package: expect.any(String),
          why: expect.any(String),
          revisit: expect.any(String),
        });
      }
    }
  });
});

describe('check-audit-floor.mjs', () => {
  it('passes a report with no advisories', () => {
    const result = gate('backend', report([]));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("audit floor ok: no unaccepted high or critical advisory in backend's production dependencies");
  });

  it('fails the #919 regression (deepmerge-ts under GHSA-ggr8-5vv4-36mx) and names the advisory and the allow-list file', () => {
    const result = gate('backend', report([DEEPMERGE]));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL GHSA-ggr8-5vv4-36mx deepmerge-ts <8.0.0 (high)');
    expect(result.stdout).toContain('1 high or critical advisory in backend');
    expect(result.stdout).toContain('accepted-advisories.json');
  });

  it('fails a critical advisory and reports each advisory once, not once per parent', () => {
    const result = gate('web', report([CRITICAL]));
    expect(result.status).toBe(1);
    expect(result.stdout.match(/^FAIL /gm)).toHaveLength(1);
    expect(result.stdout).toContain('FAIL GHSA-crit-0000-0000 evil-pkg <2.0.0 (critical)');
  });

  it('accepts an advisory listed for the side and still fails one that is not', () => {
    const result = gate('mobile', report([BRACES, DEEPMERGE]), { mobile: [accept(BRACES)] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accepted GHSA-vfj7-8cjw-p6xm braces');
    expect(result.stdout).toContain('FAIL GHSA-ggr8-5vv4-36mx');
  });

  it('exits 0 when every high advisory is accepted', () => {
    const result = gate('mobile', report([BRACES]), { mobile: [accept(BRACES)] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accepted GHSA-vfj7-8cjw-p6xm');
  });

  it('does not let an entry listed for another side excuse an advisory', () => {
    const result = gate('backend', report([BRACES]), { mobile: [accept(BRACES)] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL GHSA-vfj7-8cjw-p6xm');
  });

  it('ignores moderate and lower advisories', () => {
    const result = gate('backend', report([SPRINTF]));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('GHSA-hp3w-g68c-fv3c');
  });

  it('prints a listed advisory the audit no longer reports as stale, without failing', () => {
    const result = gate('backend', report([]), { backend: [accept(DEEPMERGE)] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('stale GHSA-ggr8-5vv4-36mx is listed for backend');
  });

  it('fails closed (exit 2) when npm audit reports an error or the report is not JSON', () => {
    expect(gate('backend', { error: { code: 'ENOTFOUND', summary: 'request failed' } }).status).toBe(2);
    expect(gate('backend', 'npm ERR! network').status).toBe(2);
  });

  it('refuses to run from a directory the allow-list does not name', () => {
    const result = gate('infra', report([]));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no "infra" key');
  });
});
