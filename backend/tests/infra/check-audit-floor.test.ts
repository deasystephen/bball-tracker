/**
 * The audit floor gate (`.github/scripts/check-audit-floor.mjs`, #924) that CI and the daily
 * upgrade scan run from each package directory. It parses `npm audit --omit=dev --json` and fails
 * on a high or critical advisory the side has not accepted in `.github/scripts/accepted-advisories.json`.
 *
 * Every test runs from a temp directory named after the side with its own allow-list through
 * `ACCEPTED_ADVISORIES_FILE`, so nothing moves when the real list changes and nothing calls the
 * network: most feed a saved report through `--report`, and the production path (no `--report`)
 * runs against a fake `npm` first on PATH that prints a saved report and exits 1, as the real one
 * does when it finds advisories. The report shapes below are what npm 11 prints (the failure body
 * was captured with `--registry=http://127.0.0.1:9`); the deepmerge-ts entry is the one the #919
 * lockfile (a767dc1) produced.
 */
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
type AllowEntry = { ghsa: string; package: string; range: string; why: string; revisit: string };

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
// npm's body when the audit endpoint cannot be reached (exit 1, this on stdout).
const NPM_FAILURE = {
  message: 'request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9',
  error: { summary: '', detail: '' },
};

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

type Result = { status: number; stdout: string; stderr: string; root: string };
type GateOptions = {
  allow?: Record<string, AllowEntry[]>;
  /** No `--report`: run the production path against a fake `npm` that prints this and exits 1. */
  fakeNpm?: string;
  reportFile?: string;
  allowFile?: string;
};

function gate(side: string, auditReport: object | string, options: GateOptions = {}): Result {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-floor-'));
  tempRoots.push(root);
  const dir = path.join(root, side);
  mkdirSync(dir);
  const text = typeof auditReport === 'string' ? auditReport : JSON.stringify(auditReport);
  const reportFile = options.reportFile ?? path.join(root, 'audit.json');
  if (!options.reportFile) writeFileSync(reportFile, text);
  const allowFile = options.allowFile ?? path.join(root, 'accepted-advisories.json');
  if (!options.allowFile) {
    writeFileSync(allowFile, JSON.stringify({ _doc: 'fixture', backend: [], web: [], mobile: [], ...options.allow }));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ACCEPTED_ADVISORIES_FILE: allowFile };
  let args = ['--report', reportFile];
  if (options.fakeNpm !== undefined) {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const output = path.join(root, 'npm-stdout.txt');
    writeFileSync(output, options.fakeNpm);
    const npm = path.join(bin, 'npm');
    writeFileSync(npm, `#!/bin/sh\necho "$@" > "${path.join(root, 'npm-args.txt')}"\ncat "${output}"\necho "npm error fake-npm stderr line" >&2\nexit 1\n`);
    chmodSync(npm, 0o755);
    env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    args = [];
  }
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env });
    return { status: 0, stdout, stderr: '', root };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, stdout: String(failed.stdout), stderr: String(failed.stderr), root };
  }
}

const accept = (a: Advisory, overrides: Partial<AllowEntry> = {}): AllowEntry => ({
  ghsa: a.url.split('/').pop() as string,
  package: a.name,
  range: a.range,
  why: 'fixture',
  revisit: 'fixture',
  ...overrides,
});

describe('accepted-advisories.json (the real list)', () => {
  it('is keyed by the three package directories and every entry names its GHSA, package, range, reason and revisit condition', () => {
    const list = JSON.parse(readFileSync(REAL_ALLOW_FILE, 'utf8')) as Record<string, AllowEntry[] | string>;
    const sides = Object.keys(list).filter((key) => !key.startsWith('_'));
    expect(sides.sort()).toEqual(['backend', 'mobile', 'web']);
    for (const side of sides) {
      for (const entry of list[side] as AllowEntry[]) {
        expect(entry).toEqual({
          ghsa: expect.stringMatching(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/),
          package: expect.any(String),
          range: expect.any(String),
          why: expect.any(String),
          revisit: expect.any(String),
        });
      }
    }
  });
});

describe('check-audit-floor.mjs verdicts (saved report through --report)', () => {
  it('passes a report with no advisories', () => {
    const result = gate('backend', report([]));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("audit floor ok: no unaccepted high or critical advisory in backend's production dependencies");
  });

  it('fails the #919 regression (deepmerge-ts under GHSA-ggr8-5vv4-36mx) and names the advisory and the allow-list file', () => {
    const result = gate('backend', report([DEEPMERGE]));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL GHSA-ggr8-5vv4-36mx deepmerge-ts <8.0.0 (high)');
    expect(result.stdout).toContain('1 high or critical advisory failed in backend');
    expect(result.stdout).toContain('accepted-advisories.json');
  });

  it('fails a critical advisory and reports each advisory once, not once per parent', () => {
    const result = gate('web', report([CRITICAL]));
    expect(result.status).toBe(1);
    expect(result.stdout.match(/^FAIL /gm)).toHaveLength(1);
    expect(result.stdout).toContain('FAIL GHSA-crit-0000-0000 evil-pkg <2.0.0 (critical)');
  });

  it('accepts an advisory listed for the side and still fails one that is not', () => {
    const result = gate('mobile', report([BRACES, DEEPMERGE]), { allow: { mobile: [accept(BRACES)] } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accepted GHSA-vfj7-8cjw-p6xm braces');
    expect(result.stdout).toContain('FAIL GHSA-ggr8-5vv4-36mx');
  });

  it('exits 0 when every high advisory is accepted at the range it was reviewed against', () => {
    const result = gate('mobile', report([BRACES]), { allow: { mobile: [accept(BRACES)] } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accepted GHSA-vfj7-8cjw-p6xm');
  });

  it('fails an accepted advisory whose reported range moved, asking for the entry to be re-reviewed', () => {
    const moved = { ...BRACES, range: '<3.0.4' };
    const result = gate('mobile', report([moved]), { allow: { mobile: [accept(BRACES)] } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL GHSA-vfj7-8cjw-p6xm braces: the advisory moved');
    expect(result.stdout).toContain('accepts range "<=3.0.3" but npm audit now reports "<3.0.4"');
    expect(result.stdout).not.toContain('stale');
  });

  it('reports a GHSA that covers two packages once per package, and an entry for one does not excuse the other', () => {
    const shared = 'GHSA-mult-ipkg-0001';
    const first = advisory('pkg-one', shared, 'high', '<1.0.1');
    const second = advisory('pkg-two', shared, 'high', '<2.0.1');
    const result = gate('backend', report([first, second]), { allow: { backend: [accept(first)] } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`accepted ${shared} pkg-one`);
    expect(result.stdout).toContain(`FAIL ${shared} pkg-two`);
  });

  it('detects a package typo in an entry: the advisory fails and the entry prints stale', () => {
    const result = gate('mobile', report([BRACES]), { allow: { mobile: [accept(BRACES, { package: 'brace' })] } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL GHSA-vfj7-8cjw-p6xm braces');
    expect(result.stdout).toContain('stale GHSA-vfj7-8cjw-p6xm brace is listed for mobile');
  });

  it('does not let an entry listed for another side excuse an advisory', () => {
    const result = gate('backend', report([BRACES]), { allow: { mobile: [accept(BRACES)] } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL GHSA-vfj7-8cjw-p6xm');
  });

  it('ignores moderate and lower advisories', () => {
    const result = gate('backend', report([SPRINTF]));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('GHSA-hp3w-g68c-fv3c');
  });

  it('prints an entry the audit no longer reports as stale, without failing', () => {
    const result = gate('backend', report([]), { allow: { backend: [accept(DEEPMERGE)] } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('stale GHSA-ggr8-5vv4-36mx deepmerge-ts is listed for backend');
  });
});

describe('check-audit-floor.mjs could not run (exit 2, never a stack trace)', () => {
  it("prints npm's own message when the audit endpoint failed", () => {
    const result = gate('backend', NPM_FAILURE);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('npm audit failed: request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed');
  });

  it('fails when the report is not JSON', () => {
    const result = gate('backend', 'npm ERR! network');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('npm audit did not return JSON');
  });

  it('fails when the report file or the allow-list file cannot be read', () => {
    const noReport = gate('backend', report([]), { reportFile: path.join(tmpdir(), 'no-such-audit-report.json') });
    expect(noReport.status).toBe(2);
    expect(noReport.stderr).toContain('cannot read the report');
    expect(noReport.stderr).not.toContain('    at ');
    const noList = gate('backend', report([]), { allowFile: path.join(tmpdir(), 'no-such-accepted-advisories.json') });
    expect(noList.status).toBe(2);
    expect(noList.stderr).toContain('cannot read');
    expect(noList.stderr).not.toContain('    at ');
  });

  it('refuses to run from a directory the allow-list does not name, and names the valid ones', () => {
    const result = gate('infra', report([]));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('run from a package directory (backend, web, mobile)');
  });
});

describe('check-audit-floor.mjs production path (fake npm on PATH, no --report)', () => {
  it('runs npm audit --omit=dev --json and recovers the JSON npm prints before exiting 1', () => {
    const result = gate('mobile', report([BRACES, DEEPMERGE]), {
      allow: { mobile: [accept(BRACES)] },
      fakeNpm: JSON.stringify(report([BRACES, DEEPMERGE])),
    });
    expect(readFileSync(path.join(result.root, 'npm-args.txt'), 'utf8').trim()).toBe('audit --omit=dev --json');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accepted GHSA-vfj7-8cjw-p6xm braces');
    expect(result.stdout).toContain('FAIL GHSA-ggr8-5vv4-36mx deepmerge-ts');
  });

  it("passes when npm's report holds only accepted advisories", () => {
    const result = gate('mobile', report([BRACES]), {
      allow: { mobile: [accept(BRACES)] },
      fakeNpm: JSON.stringify(report([BRACES])),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('audit floor ok');
  });

  it("surfaces npm's failure body and stderr", () => {
    const result = gate('backend', report([]), { fakeNpm: JSON.stringify(NPM_FAILURE) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('npm audit failed: request to http://127.0.0.1:9');
    expect(result.stderr).toContain('npm error fake-npm stderr line');
  });

  it('says npm produced no output when it prints nothing', () => {
    const result = gate('backend', report([]), { fakeNpm: '' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('npm audit produced no output');
    expect(result.stderr).toContain('npm error fake-npm stderr line');
  });
});
