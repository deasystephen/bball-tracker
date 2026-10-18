/**
 * Declared-dependency guard (#780).
 *
 * `package.json` carried three JavaScript packages nothing imported (`zod`,
 * `@amplitude/analytics-types`, `@eslint/js`) and two native ones (see the
 * allow-list). Unused packages are weekly Dependabot churn, and an unused
 * native package is compiled into every binary and pinned by the OTA drift
 * guard. This test fails when a package in `dependencies` or `devDependencies`
 * is named nowhere in the source or config files below.
 *
 * "Named" means the package name appears as a quoted string (`'pkg'`,
 * `"pkg/sub"`) or as a `pkg/` path prefix. A package that is legitimately
 * never imported goes in `NO_IMPORT_ALLOW_LIST` with the reason.
 */
import fs from 'fs';
import path from 'path';

import { MOBILE_ROOT, sourceFiles } from './helpers/source-files';

const SOURCE_DIRS = ['app', 'components', 'hooks', 'utils', 'services', 'store', 'config', 'i18n', 'theme', 'types'];
const SOURCE_FILES = [
  'index.ts',
  'app.config.js',
  'babel.config.js',
  'metro.config.js',
  'jest.config.js',
  'jest.setup.js',
  'eslint.config.mjs',
  'scripts/sentry-upload-sourcemaps.js',
];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Packages that are used without ever being imported, each with the reason. */
const NO_IMPORT_ALLOW_LIST: Record<string, string> = {
  // Removed with the next binary, #780 step 2: native, so it moves only with a new runtime.
  'lottie-react-native': 'unused; removed with the next binary, #780 step 2',
  'expo-status-bar': 'unused; removed with the next binary, #780 step 2',
  // Used by tooling or native code without an importable name.
  'react-dom': 'peer dependency of expo-router and react-native-web paths; never imported directly',
  'react-test-renderer': 'peer of @testing-library/react-native, loaded by it',
  'react-native-screens': 'peer dependency of expo-router; native screens are used through the router',
  'react-native-worklets': 'peer dependency of react-native-reanimated 4 (Babel plugin and native runtime)',
  'expo-application': 'reached only through requireOptionalNativeModule("ExpoApplication") so an OTA never crashes an older binary',
  eslint: 'CLI run by npm run lint; eslint.config.mjs imports its plugins, not the core package',
  jest: 'CLI run by npm test',
  'eas-cli': 'CLI run through npx for builds and OTA, never imported',
  '@types/jest': 'ambient test globals',
  '@types/react': 'ambient React types',
  typescript: 'compiler run by tsc and typescript-eslint',
  '@resvg/resvg-js': 'asset-generation tooling, run by hand',
};

type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function corpus(): string {
  const files = [
    ...SOURCE_DIRS.flatMap((dir) => {
      const full = path.join(MOBILE_ROOT, dir);
      return fs.existsSync(full) ? sourceFiles(full, EXTENSIONS) : [];
    }),
    ...SOURCE_FILES.map((f) => path.join(MOBILE_ROOT, f)).filter((f) => fs.existsSync(f)),
  ];
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

function isReferenced(text: string, pkg: string): boolean {
  return text.includes(`'${pkg}'`) || text.includes(`"${pkg}"`) || text.includes(`'${pkg}/`) || text.includes(`"${pkg}/`);
}

describe('declared dependencies (#780)', () => {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(MOBILE_ROOT, 'package.json'), 'utf8')) as PackageJson;
  const declared = [...Object.keys(pkgJson.dependencies ?? {}), ...Object.keys(pkgJson.devDependencies ?? {})];
  const text = corpus();

  it('scans a real corpus', () => {
    expect(declared.length).toBeGreaterThan(30);
    expect(text.length).toBeGreaterThan(10_000);
  });

  it('every declared package is referenced by source or config, or allow-listed with a reason', () => {
    const unused = declared.filter((pkg) => !(pkg in NO_IMPORT_ALLOW_LIST) && !isReferenced(text, pkg));
    expect(unused).toEqual([]);
  });

  it('the allow-list names only declared packages that really lack a reference', () => {
    const stale = Object.keys(NO_IMPORT_ALLOW_LIST).filter((pkg) => !declared.includes(pkg) || isReferenced(text, pkg));
    expect(stale).toEqual([]);
  });
});
