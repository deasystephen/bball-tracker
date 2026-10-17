/**
 * Unused-dependency guard (#781).
 *
 * Every `dependencies` entry in backend/package.json must be imported by some backend file that
 * runs: anything under `src/`, `prisma/` or `scripts/`, or a root config file (`prisma.config.ts`
 * ships in the image and is loaded by `prisma migrate deploy`). Every `@types/<x>` devDependency
 * must type a package the backend declares, or a Node built-in. A dead direct dependency passes
 * lint, type-check and the rest of the suite, keeps receiving Dependabot bumps, churns the
 * lockfile and, for `dependencies`, ships in the production image (`npm ci --omit=dev`).
 *
 * An import is `from '<name>'`, a bare `import '<name>'`, `import('<name>')`, `require('<name>')`
 * or `require.resolve('<name>')`, subpaths included, with comments stripped. A specifier built in a
 * template literal (`` import(`${name}`) ``) or a variable is not seen: such a package needs an
 * allowlist entry.
 *
 * To fix a failure: remove the package (`npm uninstall <name>` regenerates the lockfile), or, when
 * it is genuinely used without a visible import, add it to the matching allowlist with the reason.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { SCRIPT_EXTENSIONS, sourceFiles, stripComments } from '../support/source-scan';

const BACKEND_ROOT = join(__dirname, '..', '..');
const SCANNED_DIRS = ['src', 'prisma', 'scripts'];

/** Dependencies used without an import the scan can see (CLI only, computed specifier, ...). */
const DEPENDENCY_ALLOWLIST: Record<string, string> = {};

/** `@types/*` devDependencies that type a transitive package rather than a declared one. */
const TYPES_ALLOWLIST: Record<string, string> = {};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(BACKEND_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

/** Root-level config files (`prisma.config.ts`, `eslint.config.mjs`, `jest.config.js`, ...). */
function rootSourceFiles(): string[] {
  return readdirSync(BACKEND_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SCRIPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(BACKEND_ROOT, entry.name));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `from 'x'`, `import 'x'`, `import('x')`, `require('x')`, `require.resolve('x')`; subpaths too. */
function importPattern(name: string): RegExp {
  return new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire(?:\\.resolve)?\\s*\\(\\s*)['"]${escapeRegExp(name)}(?:/[^'"]*)?['"]`,
  );
}

/** `@types/foo` types `foo`; `@types/scope__pkg` types `@scope/pkg`. */
function typedPackageName(typesPackage: string): string {
  const bare = typesPackage.slice('@types/'.length);
  return bare.includes('__') ? `@${bare.replace('__', '/')}` : bare;
}

function findUnimportedDependencies(
  pkg: PackageJson,
  sources: string[],
  allowlist: Record<string, string> = DEPENDENCY_ALLOWLIST,
): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => {
    if (name in allowlist) return false;
    const pattern = importPattern(name);
    return !sources.some((source) => pattern.test(source));
  });
}

function findOrphanTypePackages(
  pkg: PackageJson,
  allowlist: Record<string, string> = TYPES_ALLOWLIST,
): string[] {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const builtins = new Set(['node', ...builtinModules]);
  return Object.keys(pkg.devDependencies ?? {})
    .filter((name) => name.startsWith('@types/') && !(name in allowlist))
    .filter((name) => {
      const typed = typedPackageName(name);
      return !declared.has(typed) && !builtins.has(typed);
    });
}

describe('backend dependency hygiene (#781)', () => {
  const pkg = readPackageJson();
  let files: string[] = [];
  let sources: string[] = [];

  beforeAll(() => {
    files = [
      ...rootSourceFiles(),
      ...SCANNED_DIRS.flatMap((dir) => sourceFiles(join(BACKEND_ROOT, dir), SCRIPT_EXTENSIONS)),
    ];
    sources = files.map((file) => stripComments(readFileSync(file, 'utf8')));
  });

  it('scans src/, prisma/, scripts/ and the root config files', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(files).toContain(join(BACKEND_ROOT, 'prisma.config.ts'));
    expect(files.some((file) => file.startsWith(join(BACKEND_ROOT, 'scripts')))).toBe(true);
  });

  it('every dependency is imported somewhere the backend runs (or allowlisted with a reason)', () => {
    expect(findUnimportedDependencies(pkg, sources)).toEqual([]);
  });

  it('every @types/<x> devDependency types a declared package or Node built-in (or is allowlisted)', () => {
    expect(findOrphanTypePackages(pkg)).toEqual([]);
  });

  it('every allowlist entry is still declared and carries a reason', () => {
    for (const [name, reason] of Object.entries(DEPENDENCY_ALLOWLIST)) {
      expect(pkg.dependencies ?? {}).toHaveProperty([name]);
      expect(reason.length).toBeGreaterThan(20);
    }
    for (const [name, reason] of Object.entries(TYPES_ALLOWLIST)) {
      expect(pkg.devDependencies ?? {}).toHaveProperty([name]);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  describe('detectors', () => {
    it('flags a dependency nothing imports and accepts every import form and subpaths', () => {
      const fake: PackageJson = {
        dependencies: Object.fromEntries(
          ['unused', 'esm', 'cjs', 'sub', 'side', 'dyn', 'resolved', 'allowed', 'commented'].map(
            (name) => [name, '1'],
          ),
        ),
      };
      const fakeSources = [
        "import { a } from 'esm';",
        "const b = require('cjs');",
        "import x from 'sub/deep/path';",
        "import 'side';",
        "const d = await import('dyn');",
        "const p = require.resolve('resolved/package.json');",
        "import { y } from 'unused-but-longer-name';",
        stripComments("// import 'commented';"),
      ];
      const allowlist = { allowed: 'side effect only, for the test' };
      expect(findUnimportedDependencies(fake, fakeSources, allowlist)).toEqual([
        'unused',
        'commented',
      ]);
    });

    it('flags an orphan @types package, maps scoped and built-in names, honours the allowlist', () => {
      const fake: PackageJson = {
        dependencies: { express: '1', '@scope/pkg': '1' },
        devDependencies: {
          '@types/express': '1',
          '@types/scope__pkg': '1',
          '@types/node': '1',
          '@types/ms': '1',
          '@types/jsonwebtoken': '1',
        },
      };
      const allowlist = { '@types/ms': 'types a transitive, for the test' };
      expect(findOrphanTypePackages(fake, allowlist)).toEqual(['@types/jsonwebtoken']);
    });
  });
});
