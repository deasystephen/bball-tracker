/**
 * The override gate the daily upgrade scan relies on (`.github/scripts/check-override-ranges.mjs`).
 *
 * The scan deletes `package.json#overrides` entries it believes dead and auto-merges the result,
 * and a wrong verdict deploys a vulnerable version unattended (#919 retired the backend's
 * `deepmerge-ts@^7` security override because `npm ls "deepmerge-ts@^7"` was empty: the override
 * had redirected the only copy to 8.x). These tests pin the semantics the script decides on:
 * declared specs, never resolved versions; npm's matching rules for aliases, peers and nested
 * blocks; the accept list as the single exemption.
 *
 * Fixtures run in a temp directory named `backend` with their own accept list (through
 * `ACCEPTED_OVERRIDES_FILE`), so they do not move when the real list changes. The real-list tests
 * read the real list and the real backend and mobile lockfiles; they are expected to go red when a
 * Prisma release declares deepmerge-ts 8.x, or expo's @expo/cli declares zod 4 (see
 * docs/automation/daily-upgrade-scan.md, "Accepted cross-major overrides"). `semver` is linked from this package's node_modules.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, '.github/scripts/check-override-ranges.mjs');
const REAL_ACCEPT_FILE = path.join(ROOT, '.github/scripts/accepted-overrides.json');
// The script's own lookup order: this package's node_modules, then npm's bundled copy.
function semverDir(): string {
  try {
    return path.dirname(require.resolve('semver/package.json'));
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return path.join(globalRoot, 'npm', 'node_modules', 'semver');
  }
}
const SEMVER_DIR = semverDir();

type LockEntry = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
};
type AcceptEntry = { override: string; consumer: string; gets: string; ghsa: string; why: string };

const realAcceptList = JSON.parse(readFileSync(REAL_ACCEPT_FILE, 'utf8')) as Record<string, AcceptEntry[] | string>;

const ACCEPT_DEEPMERGE: AcceptEntry = {
  override: 'deepmerge-ts@^7',
  consumer: 'node_modules/@prisma/config',
  gets: '^8.0.2',
  ghsa: 'GHSA-TEST-0001',
  why: 'fixture',
};

function run(
  cwd: string,
  args: string[],
  acceptFile?: string,
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env, ...(acceptFile ? { ACCEPTED_OVERRIDES_FILE: acceptFile } : {}) };
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env });
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

type Fixture = { dir: string; acceptFile: string; root: string };
function fixture(
  overrides: Record<string, unknown>,
  packages: Record<string, LockEntry>,
  accepted: AcceptEntry[] = [],
  { lockfile = true } = {},
): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'override-gate-'));
  tempRoots.push(root);
  const dir = path.join(root, 'backend');
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  symlinkSync(SEMVER_DIR, path.join(dir, 'node_modules', 'semver'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', overrides }, null, 2));
  if (lockfile) {
    writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify(
        { name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...packages } },
        null,
        2,
      ),
    );
  }
  const acceptFile = path.join(root, 'accepted.json');
  writeFileSync(acceptFile, JSON.stringify({ _doc: 'fixture', backend: accepted, web: [], mobile: [] }, null, 2));
  return { dir, acceptFile, root };
}

// Plain x.y.z comparison (lockfile versions here carry no prerelease tag).
function versionBelow(version: string, floor: [number, number, number]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    if ((parts[i] ?? 0) !== floor[i]) return (parts[i] ?? 0) < floor[i];
  }
  return false;
}

describe('accepted-overrides.json (the real list)', () => {
  it('is keyed by the three package directories and every entry names its fields', () => {
    const sides = Object.keys(realAcceptList).filter((key) => !key.startsWith('_'));
    expect(sides.sort()).toEqual(['backend', 'mobile', 'web']);
    for (const side of sides) {
      for (const entry of realAcceptList[side] as AcceptEntry[]) {
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

  it("the backend's deepmerge-ts override is accepted against the real lockfile (goes red when Prisma declares 8.x: retire it, see the docs)", () => {
    const entry = (realAcceptList.backend as AcceptEntry[]).find((e) => e.override === 'deepmerge-ts@^7');
    expect(entry).toBeDefined();
    const result = run(path.join(ROOT, 'backend'), ['deepmerge-ts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accepted node_modules/@prisma/config declares deepmerge-ts@');
    expect(result.stdout).toMatch(/0 cross-major mismatch\(es\), 1 accepted/);
  });

  // GHSA-mrhx-c7xc-m3w5: red here means the `zod@^3` override stopped working (a regenerated
  // lockfile brought a zod 3.x copy back). Restore the override; never retire it for this.
  it("mobile's zod@^3 override still lifts every zod in the real lockfile to >=4.6.6 (security floor, not a retire signal)", () => {
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'mobile/package-lock.json'), 'utf8')) as {
      packages: Record<string, LockEntry>;
    };
    const below = Object.entries(lock.packages)
      .filter(([p, e]) => /(^|\/)node_modules\/zod$/.test(p) && versionBelow(e.version ?? '0.0.0', [4, 6, 6]))
      .map(([p, e]) => `${p}@${e.version}`);
    expect(below).toEqual([]);
  });

  // Red with "gets" still >=4.6.6 means one of two things: expo's @expo/cli now declares zod 4
  // (retire the override, its accepted-overrides.json entry and this test, see the docs), or npm
  // hoisted @expo/cli to another path (update the entry's `consumer`), or a new package declares
  // zod 3 and is being forced across the major (the mismatch line names it; scope or rethink).
  it("mobile's zod@^3 override is accepted for @expo/cli and forces no other consumer across a major", () => {
    const entry = (realAcceptList.mobile as AcceptEntry[]).find((e) => e.override === 'zod@^3');
    expect(entry).toBeDefined();
    const result = run(path.join(ROOT, 'mobile'), ['zod']);
    expect(result.stdout).toContain(`accepted ${entry?.consumer} declares zod@^3`);
    expect(result.stdout).toMatch(/0 cross-major mismatch\(es\), 1 accepted/);
    expect(result.status).toBe(0);
  });
});

describe('range mode', () => {
  it('fails a cross-major redirect that is not accepted, lists a same-major floor, exits 0 when clean', () => {
    const f = fixture(
      { 'foo@^1': '^2.0.0', bar: '^1.9.0' },
      {
        'node_modules/consumer': { version: '1.0.0', dependencies: { foo: '^1.2.0', bar: '1.4.0', baz: '^1' } },
        'node_modules/foo': { version: '2.0.0' },
        'node_modules/bar': { version: '1.9.0' },
        'node_modules/baz': { version: '1.0.0' },
      },
    );
    const mismatch = run(f.dir, ['foo'], f.acceptFile);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain('MISMATCH node_modules/consumer declares foo@^1.2.0 but gets 2.0.0');
    const floor = run(f.dir, ['bar', 'baz'], f.acceptFile);
    expect(floor.status).toBe(0);
    expect(floor.stdout).toContain('floor    node_modules/consumer declares bar@1.4.0, gets 1.9.0 (same major)');
    expect(floor.stdout).toMatch(/0 cross-major mismatch\(es\), 0 accepted, 1 same-major floor/);
  });

  it('counts an installed peer edge as a consumer, but not a peer that nothing installed', () => {
    const f = fixture(
      { foo: '^2.0.0' },
      {
        'node_modules/host': { version: '1.0.0', peerDependencies: { foo: '^1' } },
        'node_modules/optional-host': { version: '1.0.0', peerDependencies: { ghost: '^1' } },
        'node_modules/foo': { version: '2.0.0' },
      },
    );
    const result = run(f.dir, ['foo', 'ghost'], f.acceptFile);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MISMATCH node_modules/host declares foo@^1 but gets 2.0.0');
    expect(result.stdout).not.toContain('ghost@');
  });

  it('accepts the listed mismatch only for the listed consumer and resolved range', () => {
    const f = fixture(
      { 'deepmerge-ts@^7': '^8.0.2' },
      {
        'node_modules/@prisma/config': { version: '7.10.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/other': { version: '1.0.0', dependencies: { 'deepmerge-ts': '^7.0.0' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
      [ACCEPT_DEEPMERGE],
    );
    const result = run(f.dir, ['deepmerge-ts'], f.acceptFile);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'accepted node_modules/@prisma/config declares deepmerge-ts@7.1.5 but gets 8.0.2 (GHSA-TEST-0001',
    );
    expect(result.stdout).toContain('MISMATCH node_modules/other declares deepmerge-ts@^7.0.0 but gets 8.0.2');
    const wrongRange = run(f.dir, ['deepmerge-ts'], fixture({}, {}, [{ ...ACCEPT_DEEPMERGE, gets: '^9' }]).acceptFile);
    expect(wrongRange.stdout).toContain('MISMATCH node_modules/@prisma/config declares deepmerge-ts@7.1.5');
  });
});

describe('--overrides liveness', () => {
  it('decides on declared specs: the #919 shape is live, not dead', () => {
    const f = fixture(
      { 'deepmerge-ts@^7': '^8.0.2', 'left-pad': '^1.3.0', 'deepmerge-ts@^9': '^9.0.0' },
      {
        'node_modules/@prisma/config': { version: '7.10.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
      [ACCEPT_DEEPMERGE],
    );
    const result = run(f.dir, ['--overrides'], f.acceptFile);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'live  "deepmerge-ts@^7"  (accepted GHSA-TEST-0001; node_modules/@prisma/config declares deepmerge-ts@7.1.5)',
    );
    expect(result.stdout).toContain('DEAD  "left-pad"');
    expect(result.stdout).toContain('DEAD  "deepmerge-ts@^9"');
    expect(result.stdout).toContain('1 live, 0 stale, 2 dead override key(s)');
  });

  it('is live without an accept entry too, through any declarer', () => {
    const f = fixture(
      { 'deepmerge-ts@^7': '^8.0.2' },
      {
        'node_modules/@prisma/config': { version: '7.10.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
    );
    expect(run(f.dir, ['--overrides'], f.acceptFile).stdout).toContain(
      'live  "deepmerge-ts@^7"  <- node_modules/@prisma/config declares deepmerge-ts@7.1.5',
    );
  });

  it('counts peer dependencies and the root devDependencies', () => {
    const f = fixture(
      { 'peeronly@^1': '^1.9.0', devonly: '^2.0.0' },
      {
        '': { name: 'fixture', devDependencies: { devonly: '^2' } },
        'node_modules/host': { version: '1.0.0', peerDependencies: { peeronly: '^1' } },
        'node_modules/peeronly': { version: '1.9.0' },
        'node_modules/devonly': { version: '2.0.0' },
      },
    );
    const { stdout } = run(f.dir, ['--overrides'], f.acceptFile);
    expect(stdout).toContain('live  "peeronly@^1"  <- node_modules/host declares peeronly@^1');
    expect(stdout).toContain('live  "devonly"  <- (root) declares devonly@^2');
  });

  it('matches an npm: alias under the alias name, as npm does, never under the aliased package', () => {
    const f = fixture(
      { 'string-width-cjs': '^4.2.4', 'string-width@^4': '^4.2.4' },
      {
        'node_modules/consumer': { version: '1.0.0', dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' } },
        'node_modules/string-width-cjs': { version: '4.2.4' },
      },
    );
    const { stdout } = run(f.dir, ['--overrides'], f.acceptFile);
    expect(stdout).toContain('live  "string-width-cjs"  <- node_modules/consumer declares string-width-cjs@^4.2.0');
    expect(stdout).toContain('DEAD  "string-width@^4"');
  });

  it('scopes nested blocks to the parent copies and their graph, at every depth, honouring a `.` redirect', () => {
    const f = fixture(
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
    const { stdout } = run(f.dir, ['--overrides'], f.acceptFile);
    expect(stdout).toContain('DEAD  "nested" > "inner" > "deep"');
    expect(stdout).toContain(
      'live  "nested2" > "inner" > "present"  <- node_modules/nested2/node_modules/inner declares present@^1',
    );
    expect(stdout).toContain('live  "foo@^1" > "." ');
    expect(stdout).toContain('live  "foo@^1" > "bar"  <- node_modules/foo declares bar@^3.1.0');
    expect(stdout).toContain('DEAD  "elsewhere" > "lonely"');
  });

  it('keeps an accepted key live only through its listed consumer; otherwise STALE', () => {
    const viaOther = fixture(
      { 'deepmerge-ts@^7': '^8.0.2' },
      {
        'node_modules/@prisma/config': { version: '8.0.0', dependencies: { 'deepmerge-ts': '^8.0.2' } },
        'node_modules/other': { version: '1.0.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
      [ACCEPT_DEEPMERGE],
    );
    const result = run(viaOther.dir, ['--overrides'], viaOther.acceptFile);
    expect(result.stdout).toContain(
      'STALE "deepmerge-ts@^7"  (accepted GHSA-TEST-0001, but node_modules/@prisma/config no longer declares it; other declarers: node_modules/other declares deepmerge-ts@7.1.5',
    );
    expect(result.stdout).toContain('0 live, 1 stale, 0 dead override key(s)');

    const nobody = fixture(
      { 'deepmerge-ts@^7': '^8.0.2' },
      { 'node_modules/deepmerge-ts': { version: '8.0.2' } },
      [ACCEPT_DEEPMERGE],
    );
    expect(run(nobody.dir, ['--overrides'], nobody.acceptFile).stdout).toContain(
      'STALE "deepmerge-ts@^7"  (accepted GHSA-TEST-0001, but node_modules/@prisma/config no longer declares it: retire it',
    );
  });

  it('reports an accept entry whose key is gone from package.json as ORPHAN, and does not apply a top-level entry to a nested key', () => {
    const f = fixture(
      { 'eas-cli': { 'deepmerge-ts@^7': '^8.0.2' } },
      {
        'node_modules/eas-cli': { version: '1.0.0', dependencies: { 'deepmerge-ts': '7.1.5' } },
        'node_modules/deepmerge-ts': { version: '8.0.2' },
      },
      [ACCEPT_DEEPMERGE],
    );
    const { stdout } = run(f.dir, ['--overrides'], f.acceptFile);
    expect(stdout).toContain('live  "eas-cli" > "deepmerge-ts@^7"  <- node_modules/eas-cli declares deepmerge-ts@7.1.5');
    expect(stdout).toContain('ORPHAN "deepmerge-ts@^7"  (accepted GHSA-TEST-0001, but package.json#overrides has no such key');
    expect(stdout).toContain('1 live, 0 stale, 0 dead override key(s), 1 orphan accept entry');
  });

  it('does not call a block-shaped accepted key ORPHAN, and accepts only its `.` child', () => {
    const f = fixture(
      { 'foo@^1': { '.': '^2.0.0', bar: '^3' } },
      {
        'node_modules/consumer': { version: '1.0.0', dependencies: { foo: '^1.0.0' } },
        'node_modules/foo': { version: '2.0.0', dependencies: { bar: '^3.1.0' } },
        'node_modules/bar': { version: '3.1.0' },
      },
      [{ ...ACCEPT_DEEPMERGE, override: 'foo@^1', consumer: 'node_modules/foo', gets: '^2.0.0' }],
    );
    const { stdout } = run(f.dir, ['--overrides'], f.acceptFile);
    expect(stdout).not.toContain('ORPHAN');
    expect(stdout).toContain('live  "foo@^1" > "."  (accepted GHSA-TEST-0001; node_modules/foo declares foo@2.0.0)');
    expect(stdout).toContain('live  "foo@^1" > "bar"  <- node_modules/foo declares bar@^3.1.0');
  });

  it('ignores a peer edge that nothing installed, in both modes', () => {
    const f = fixture(
      { react: '^19.2.0' },
      {
        'node_modules/studio': { version: '1.0.0', peerDependencies: { react: '^18 || ^19' } },
        'node_modules/host': { version: '1.0.0', peerDependencies: { installed: '^1' } },
        'node_modules/installed': { version: '1.5.0' },
      },
    );
    expect(run(f.dir, ['--overrides'], f.acceptFile).stdout).toContain('DEAD  "react"');
    const range = run(f.dir, ['react', 'installed'], f.acceptFile);
    expect(range.status).toBe(0);
    expect(range.stdout).not.toContain('react@');
  });

  it('counts an unsupported override value separately from DEAD', () => {
    const f = fixture({ num: 5, gone: '^1' }, {});
    const { stdout } = run(f.dir, ['--overrides'], f.acceptFile);
    expect(stdout).toContain('??    "num"  unsupported override value 5');
    expect(stdout).toContain('0 live, 0 stale, 1 dead override key(s), 1 unsupported');
  });
});

describe('argument and directory validation', () => {
  it('rejects a misplaced or unknown flag, a wrong directory and a directory without a lockfile', () => {
    const f = fixture({}, {});
    expect(run(f.dir, ['deepmerge-ts', '--overrides'], f.acceptFile).status).toBe(2);
    expect(run(f.dir, ['--bogus'], f.acceptFile).status).toBe(2);
    expect(run(f.dir, [], f.acceptFile).status).toBe(2);
    const wrongDir = run(f.root, ['--overrides'], f.acceptFile);
    expect(wrongDir.status).toBe(2);
    expect(wrongDir.stderr).toContain('run from a package directory');
    const noLock = fixture({}, {}, [], { lockfile: false });
    const missing = run(noLock.dir, ['--overrides'], noLock.acceptFile);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('run from a package directory');
  });
});
