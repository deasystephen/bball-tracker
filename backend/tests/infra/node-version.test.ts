/**
 * Config-bound test over the Node.js major version (#714).
 *
 * Production runs the backend on the Node major in `docker/Dockerfile`. CI, the
 * migration backfill guard and the daily upgrade scan must run the same major,
 * or the suites and the scan judge code on an engine production does not run
 * (CLAUDE.md: "Tests exercise the path production runs"). The major is written
 * in files that cannot share a constant:
 *
 *  - `docker/Dockerfile` (`FROM node:<major>-alpine`), the production image;
 *  - the root `.nvmrc`, which every `actions/setup-node` step reads through
 *    `node-version-file: .nvmrc`;
 *  - `backend/package.json` `engines.node` (`>=<major>`).
 *
 * This suite fails on any disagreement, on a `setup-node` step that does not
 * read `.nvmrc` (no version, another file, or a hardcoded `node-version`,
 * which `actions/setup-node` would prefer over `node-version-file`), and when any extraction finds nothing
 * (a file that changed shape fails loudly rather than passing vacuously).
 * Modelled on `postgres-version.test.ts`.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { ROOT, WORKFLOWS_DIR, workflowFiles } from './workflows';

const DOCKERFILE = path.join(ROOT, 'docker/Dockerfile');
const NVMRC = path.join(ROOT, '.nvmrc');
const BACKEND_PACKAGE = path.join(ROOT, 'backend/package.json');

export const DOCKERFILE_PATTERN = /^FROM node:(\d+)-alpine\b/m;
export const NVMRC_PATTERN = /^\s*(\d+)\s*$/;
export const ENGINES_PATTERN = /^>=(\d+)$/;

const SETUP_NODE_USES = /^(\s*)(?:-\s+)?uses:\s*actions\/setup-node@/;
const NODE_VERSION_FILE = /^\s*node-version-file:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/;
const NODE_VERSION = /^\s*node-version:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/;

export function extractMajor(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(
      `${label}: could not find the Node.js major with ${pattern}. ` +
        'If the file changed shape, update the pattern in tests/infra/node-version.test.ts — ' +
        'do not let this test pass vacuously.',
    );
  }
  return match[1];
}

/**
 * The Node major each `actions/setup-node` step in one workflow resolves to.
 * Every step must read `node-version-file: .nvmrc` (resolved to `nvmrcMajor`).
 * A `node-version` key throws, even next to `node-version-file`: setup-node
 * gives `node-version` precedence, so the step would run that version instead.
 * No version or another file also throws.
 */
export function setupNodeMajors(source: string, nvmrcMajor: string, label: string): string[] {
  const lines = source.split('\n');
  const majors: string[] = [];
  lines.forEach((line, index) => {
    const uses = line.match(SETUP_NODE_USES);
    if (!uses) return;
    // The step's own keys are indented deeper than the `- ` that opens it; the
    // step ends at the next line indented at or above that dash.
    const stepIndent = line.trimStart().startsWith('-') ? uses[1].length : uses[1].length - 2;
    let resolved: string | undefined;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next];
      if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) continue;
      const indent = candidate.length - candidate.trimStart().length;
      if (indent <= stepIndent) break;
      const file = candidate.match(NODE_VERSION_FILE);
      if (file) {
        if (file[1] !== '.nvmrc') {
          throw new Error(`${label}:${next + 1}: setup-node reads ${file[1]}; use node-version-file: .nvmrc.`);
        }
        resolved = nvmrcMajor;
      }
      const version = candidate.match(NODE_VERSION);
      if (version) {
        throw new Error(
          `${label}:${next + 1}: setup-node sets node-version "${version[1]}"; ` +
            'read the major from the root .nvmrc with node-version-file: .nvmrc instead.',
        );
      }
    }
    if (resolved === undefined) {
      throw new Error(
        `${label}:${index + 1}: setup-node names no Node version; add node-version-file: .nvmrc.`,
      );
    }
    majors.push(resolved);
  });
  return majors;
}

describe('Node.js major — Dockerfile / .nvmrc / engines / workflows parity', () => {
  const docker = extractMajor(readFileSync(DOCKERFILE, 'utf8'), DOCKERFILE_PATTERN, 'docker/Dockerfile');
  const nvmrc = extractMajor(readFileSync(NVMRC, 'utf8'), NVMRC_PATTERN, '.nvmrc');
  const pkg = JSON.parse(readFileSync(BACKEND_PACKAGE, 'utf8')) as { engines?: { node?: string } };
  const engines = extractMajor(pkg.engines?.node ?? '', ENGINES_PATTERN, 'backend/package.json engines.node');

  it('pins the production image major in .nvmrc and backend engines.node', () => {
    expect(nvmrc).toBe(docker);
    expect(engines).toBe(docker);
  });

  it('runs every actions/setup-node step in every workflow on the production major', () => {
    const steps = workflowFiles().flatMap((name) =>
      setupNodeMajors(readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'), nvmrc, `.github/workflows/${name}`).map(
        (major) => ({ name, major }),
      ),
    );
    // ci.yml (x4), migration-backfill-guard.yml and daily-upgrade-scan.yml set up Node.
    expect(steps.length).toBeGreaterThanOrEqual(6);
    for (const step of steps) {
      expect({ workflow: step.name, major: step.major }).toEqual({ workflow: step.name, major: docker });
    }
  });
});

describe('Node.js major — extraction self-test', () => {
  it('reads the majors the files currently declare', () => {
    expect(extractMajor('# Backend\nFROM node:22-alpine AS base\n', DOCKERFILE_PATTERN, 'docker')).toBe('22');
    expect(extractMajor('22\n', NVMRC_PATTERN, 'nvmrc')).toBe('22');
    expect(extractMajor('>=22', ENGINES_PATTERN, 'engines')).toBe('22');
  });

  it('refuses shapes that are not a bare major', () => {
    expect(() => extractMajor('FROM node:lts-alpine', DOCKERFILE_PATTERN, 'docker')).toThrow(/could not find/);
    expect(() => extractMajor('lts/*', NVMRC_PATTERN, 'nvmrc')).toThrow(/could not find/);
    expect(() => extractMajor('^22.12', ENGINES_PATTERN, 'engines')).toThrow(/could not find/);
    expect(() => extractMajor('', ENGINES_PATTERN, 'engines')).toThrow(/could not find/);
  });

  it('resolves setup-node steps that read .nvmrc', () => {
    const workflow = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - name: Setup Node.js',
      '        uses: actions/setup-node@v7',
      '        with:',
      '          node-version-file: .nvmrc',
      "          cache: 'npm'",
      '      - uses: actions/setup-node@v7',
      '        with:',
      "          node-version-file: '.nvmrc'",
      '      - run: npm ci',
    ].join('\n');
    expect(setupNodeMajors(workflow, '22', 'wf')).toEqual(['22', '22']);
  });

  it('fails a step that names no version, a hardcoded version or another file', () => {
    const noVersion = ['    steps:', '      - uses: actions/setup-node@v7', '      - run: npm ci'].join('\n');
    expect(() => setupNodeMajors(noVersion, '22', 'wf')).toThrow(/names no Node version/);
    const hardcoded = ['      - uses: actions/setup-node@v7', '        with:', "          node-version: '22'"].join('\n');
    expect(() => setupNodeMajors(hardcoded, '22', 'wf')).toThrow(/wf:3: setup-node sets node-version "22"/);
    const lts = ['      - uses: actions/setup-node@v7', '        with:', "          node-version: 'lts/*'"].join('\n');
    expect(() => setupNodeMajors(lts, '22', 'wf')).toThrow(/sets node-version "lts\/\*"/);
    const otherFile = ['      - uses: actions/setup-node@v7', '        with:', '          node-version-file: web/.nvmrc'].join(
      '\n',
    );
    expect(() => setupNodeMajors(otherFile, '22', 'wf')).toThrow(/use node-version-file: \.nvmrc/);
  });

  it('fails a step that sets both keys, since setup-node prefers node-version', () => {
    for (const order of [
      ['          node-version-file: .nvmrc', "          node-version: '20'"],
      ["          node-version: '20'", '          node-version-file: .nvmrc'],
    ]) {
      const workflow = ['      - uses: actions/setup-node@v7', '        with:', ...order].join('\n');
      expect(() => setupNodeMajors(workflow, '22', 'wf')).toThrow(/sets node-version "20"/);
    }
  });

  it('does not borrow the version of the next step', () => {
    const workflow = [
      '      - uses: actions/setup-node@v7',
      '      - uses: actions/setup-node@v7',
      '        with:',
      '          node-version-file: .nvmrc',
    ].join('\n');
    expect(() => setupNodeMajors(workflow, '22', 'wf')).toThrow(/wf:1: setup-node names no Node version/);
  });
});
