/**
 * The override gate the daily upgrade scan relies on (`.github/scripts/check-override-ranges.mjs`).
 *
 * The scan deletes `package.json#overrides` entries it believes dead and auto-merges the result,
 * and a wrong verdict deploys a vulnerable version unattended (#919 retired the backend's
 * `deepmerge-ts@^7` security override because `npm ls "deepmerge-ts@^7"` was empty: the override
 * had redirected the only copy to 8.x). These tests pin the semantics the script decides on:
 * declared specs, never resolved versions; npm's matching rules for aliases and nested blocks;
 * the accept list as the single exemption.
 *
 * Fixtures are written to a temp directory named `backend` so the accept list's backend entries
 * apply to them. `semver` is linked from this package's node_modules.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/check-override-ranges.mjs');
const ACCEPT_FILE = path.join(ROOT, '.github/scripts/accepted-overrides.json');
const SEMVER_DIR = path.dirname(require.resolve('semver/package.json'));

type LockEntry = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type AcceptEntry = { override: string; consumer: string; gets: string; ghsa: string; why: string };

const acceptList = JSON.parse(readFileSync(ACCEPT_FILE, 'utf8')) as Record<string, AcceptEntry[] | string>;
const backendAccepted = acceptList.backend as AcceptEntry[];
const deepmerge = backendAccepted.find((entry) => entry.override === 'deepmerge-ts@^7');

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, stdout: String(failed.stdout), stderr: String(failed.stderr) };
  }
}

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown>, packages: Record<string, LockEntry>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'override-gate-'));
  tempRoots.push(root);
  const dir = path.join(root, 'backend');
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  symlinkSync(SEMVER_DIR, path.join(dir, 'node_modules', 'semver'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', overrides }, null, 2));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...packages } }, null, 2),
  );
  return dir;
}

describe('accepted-overrides.json', () => {
  it('is keyed by the three package directories and every entry names its fields', () => {
    const sides = Object.keys(acceptList).filter((key) => !key.startsWith('_'));
    expect(sides.sort()).toEqual(['backend', 'mobile', 'web']);
    for (const side of sides) {
      for (const entry of acceptList[side] as AcceptEntry[]) {
        expect(entry).toEqual(
          expect.objectContaining({
            override: expect.any(String),
            consumer: expect.stringMatching(/^(node_modules\/|\(root\)$)/),
            gets: expect.any(String),
            ghsa: expect.stringMatching(/^GHSA-/),
            why: expect.any(String),
          }),
        );
      }
    }
  });

  it("the backend's deepmerge-ts override is listed and accepted against the real lockfile", () => {
    expect(deepmerge).toBeDefined();
    const result = run(path.join(ROOT, 'backend'), ['deepmerge-ts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted node_modules/@prisma/config declares deepmerge-ts@`);
    expect(result.stdout).toMatch(/0 cross-major mismatch\(es\), 1 accepted/);
  });
});

describe('range mode', () => {
  it('fails a cross-major redirect that is not accepted, lists a same-major floor, exits 0 when clean', () => {
    const dir = fixture(
      { 'foo@^1': '^2.0.0', bar: '^1.9.0' },
      {
        'node_modules/consumer': { version: '1.0.0', dependencies: { foo: '^1.2.0', bar: '1.4.0', baz: '^1' } },
        'node_modules/foo': { version: '2.0.0' },
        'node_modules/bar': { version: '1.9.0' },
        'node_modules/baz': { version: '1.0.0' },
      },
    );
    const mismatch = run(dir, ['foo']);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain('MISMATCH node_modules/consumer declares foo@^1.2.0 but gets 2.0.0');
    const floor = run(dir, ['bar', 'baz']);
    expect(floor.status).toBe(0);
    expect(floor.stdout).toContain('floor    node_modules/consumer declares bar@1.4.0, gets 1.9.0 (same major)');
    expect(floor.stdout).toMatch(/0 cross-major mismatch\(es\), 0 accepted, 1 same-major floor/);
  });

  it('accepts the listed mismatch only for the listed consumer and resolved range', () => {
    const dir = fixture(
      { 'deepmerge-ts@^7': '^8.0.2' },
      {
        'node_modules/@prisma/config': { version: '7.10.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/other': { version: '1.0.0', dependencies: { 'deepmerge-ts': '^7.0.0' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
    );
    const result = run(dir, ['deepmerge-ts']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `accepted node_modules/@prisma/config declares deepmerge-ts@7.1.5 but gets 8.0.2 (${deepmerge?.ghsa}`,
    );
    expect(result.stdout).toContain('MISMATCH node_modules/other declares deepmerge-ts@^7.0.0 but gets 8.0.2');
  });
});

describe('--overrides liveness', () => {
  it('decides on declared specs: the #919 shape is live, not dead', () => {
    const dir = fixture(
      { 'deepmerge-ts@^7': '^8.0.2', 'left-pad': '^1.3.0', 'deepmerge-ts@^9': '^9.0.0' },
      {
        'node_modules/@prisma/config': { version: '7.10.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
    );
    const result = run(dir, ['--overrides']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `live  "deepmerge-ts@^7"  (accepted ${deepmerge?.ghsa}; node_modules/@prisma/config declares deepmerge-ts@7.1.5)`,
    );
    expect(result.stdout).toContain('DEAD  "left-pad"');
    expect(result.stdout).toContain('DEAD  "deepmerge-ts@^9"');
    expect(result.stdout).toContain('1 live, 0 stale, 2 dead override key(s)');
  });

  it('counts peer dependencies and the root devDependencies', () => {
    const dir = fixture(
      { 'peeronly@^1': '^1.9.0', devonly: '^2.0.0' },
      {
        '': { name: 'fixture', devDependencies: { devonly: '^2' } },
        'node_modules/host': { version: '1.0.0', peerDependencies: { peeronly: '^1' } },
        'node_modules/peeronly': { version: '1.9.0' },
        'node_modules/devonly': { version: '2.0.0' },
      },
    );
    const { stdout } = run(dir, ['--overrides']);
    expect(stdout).toContain('live  "peeronly@^1"  <- node_modules/host declares peeronly@^1');
    expect(stdout).toContain('live  "devonly"  <- (root) declares devonly@^2');
  });

  it('matches an npm: alias under the alias name, as npm does, never under the aliased package', () => {
    const dir = fixture(
      { 'string-width-cjs': '^4.2.4', 'string-width@^4': '^4.2.4' },
      {
        'node_modules/consumer': { version: '1.0.0', dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' } },
        'node_modules/string-width-cjs': { version: '4.2.4' },
      },
    );
    const { stdout } = run(dir, ['--overrides']);
    expect(stdout).toContain('live  "string-width-cjs"  <- node_modules/consumer declares string-width-cjs@^4.2.0');
    expect(stdout).toContain('DEAD  "string-width@^4"');
  });

  it('scopes nested blocks to the parent copies and their graph, at every depth, honouring a `.` redirect', () => {
    const dir = fixture(
      {
        nested: { inner: { deep: '^1' } },
        nested2: { inner: { present: '^1' } },
        'foo@^1': { '.': '^2.0.0', bar: '^3' },
        elsewhere: { lonely: '^1' },
      },
      {
        'node_modules/nested': { version: '1.0.0', dependencies: { inner: '^1' } },
        'node_modules/inner': { version: '1.0.0' },
        'node_modules/nested2': { version: '1.0.0', dependencies: { inner: '^1' } },
        'node_modules/nested2/node_modules/inner': { version: '1.2.0', dependencies: { present: '^1' } },
        'node_modules/present': { version: '1.0.0' },
        'node_modules/foo': { version: '2.0.0', dependencies: { bar: '^3.1.0' } },
        'node_modules/bar': { version: '3.1.0' },
        'node_modules/elsewhere': { version: '1.0.0' },
        'node_modules/unrelated': { version: '1.0.0', dependencies: { lonely: '^1' } },
        'node_modules/lonely': { version: '1.0.0' },
      },
    );
    const { stdout } = run(dir, ['--overrides']);
    expect(stdout).toContain('DEAD  "nested" > "inner" > "deep"');
    expect(stdout).toContain(
      'live  "nested2" > "inner" > "present"  <- node_modules/nested2/node_modules/inner declares present@^1',
    );
    expect(stdout).toContain('live  "foo@^1" > "." ');
    expect(stdout).toContain('live  "foo@^1" > "bar"  <- node_modules/foo declares bar@^3.1.0');
    expect(stdout).toContain('DEAD  "elsewhere" > "lonely"');
  });

  it('reports an accepted key that nothing declares any more as STALE, never live or dead', () => {
    const dir = fixture(
      { 'deepmerge-ts@^7': '^8.0.2' },
      {
        'node_modules/@prisma/config': { version: '8.0.0', dependencies: { 'deepmerge-ts': '^8.0.2' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
    );
    const { stdout } = run(dir, ['--overrides']);
    expect(stdout).toContain('STALE "deepmerge-ts@^7"  (accepted GHSA-');
    expect(stdout).toContain('0 live, 1 stale, 0 dead override key(s)');
  });
});

describe('argument and directory validation', () => {
  it('rejects a misplaced or unknown flag and a directory without a lockfile', () => {
    const dir = fixture({}, {});
    expect(run(dir, ['deepmerge-ts', '--overrides']).status).toBe(2);
    expect(run(dir, ['--bogus']).status).toBe(2);
    expect(run(dir, []).status).toBe(2);
    const wrong = run(path.dirname(dir), ['--overrides']);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('run from a package directory');
  });
});
