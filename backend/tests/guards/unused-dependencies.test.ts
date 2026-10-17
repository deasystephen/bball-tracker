/**
 * Unused-dependency guard (#781).
 *
 * Every `dependencies` entry in backend/package.json must be imported by some file under
 * `src/` or `prisma/`, and every `@types/<x>` devDependency must type a package the backend
 * actually declares (or a Node built-in). A dead direct dependency passes lint, type-check
 * and the rest of the suite, keeps receiving Dependabot bumps, churns the lockfile and, for
 * `dependencies`, ships in the production image (`npm ci --omit=dev` in docker/Dockerfile).
 *
 * To fix a failure: remove the package (`npm uninstall <name>` regenerates the lockfile),
 * or, when it is genuinely used without an import, add it to ALLOWLIST with the reason.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { sourceFiles, stripComments } from '../support/source-scan';

const BACKEND_ROOT = join(__dirname, '..', '..');
const SCANNED_DIRS = ['src', 'prisma'];

/** Dependencies that are used without a JavaScript import under src/ or prisma/. */
const ALLOWLIST: Record<string, string> = {
  prisma:
    'CLI only: docker/entrypoint.sh runs ./node_modules/.bin/prisma migrate deploy at container start, ' +
    'so it must stay in dependencies (installed by npm ci --omit=dev).',
};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(BACKEND_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `from 'x'`, `import 'x'`, `import('x')`, `require('x')`, and subpaths like `x/sub`. */
function importPattern(name: string): RegExp {
  return new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)['"]${escapeRegExp(name)}(?:/[^'"]*)?['"]`,
  );
}

/** `@types/foo` types `foo`; `@types/scope__pkg` types `@scope/pkg`. */
function typedPackageName(typesPackage: string): string {
  const bare = typesPackage.slice('@types/'.length);
  return bare.includes('__') ? `@${bare.replace('__', '/')}` : bare;
}

function findUnimportedDependencies(pkg: PackageJson, sources: string[]): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter(
    (name) => !(name in ALLOWLIST) && !sources.some((source) => importPattern(name).test(source)),
  );
}

function findOrphanTypePackages(pkg: PackageJson): string[] {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const builtins = new Set(['node', ...builtinModules]);
  return Object.keys(pkg.devDependencies ?? {})
    .filter((name) => name.startsWith('@types/'))
    .filter((name) => {
      const typed = typedPackageName(name);
      return !declared.has(typed) && !builtins.has(typed);
    });
}

describe('backend dependency hygiene (#781)', () => {
  const pkg = readPackageJson();
  let sources: string[] = [];

  beforeAll(() => {
    sources = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(BACKEND_ROOT, dir))).map((file) =>
      stripComments(readFileSync(file, 'utf8')),
    );
  });

  it('scans a non-trivial set of source files', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('every dependency is imported under src/ or prisma/ (or allowlisted with a reason)', () => {
    expect(findUnimportedDependencies(pkg, sources)).toEqual([]);
  });

  it('every allowlisted package is still a dependency and carries a reason', () => {
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      expect(pkg.dependencies ?? {}).toHaveProperty([name]);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('every @types/<x> devDependency has a matching <x> package or Node built-in', () => {
    expect(findOrphanTypePackages(pkg)).toEqual([]);
  });

  describe('detectors', () => {
    it('flags a dependency nothing imports and accepts import forms and subpaths', () => {
      const fake: PackageJson = {
        dependencies: { unused: '1', esm: '1', cjs: '1', sub: '1', side: '1', dyn: '1', prisma: '1' },
      };
      const fakeSources = [
        "import { a } from 'esm';",
        "const b = require('cjs');",
        "import x from 'sub/deep/path';",
        "import 'side';",
        "const d = await import('dyn');",
        "import { y } from 'unused-but-longer-name';",
      ];
      expect(findUnimportedDependencies(fake, fakeSources)).toEqual(['unused']);
    });

    it('flags an orphan @types package and maps scoped and built-in names', () => {
      const fake: PackageJson = {
        dependencies: { express: '1', '@scope/pkg': '1' },
        devDependencies: {
          '@types/express': '1',
          '@types/scope__pkg': '1',
          '@types/node': '1',
          '@types/jsonwebtoken': '1',
        },
      };
      expect(findOrphanTypePackages(fake)).toEqual(['@types/jsonwebtoken']);
    });
  });
});
