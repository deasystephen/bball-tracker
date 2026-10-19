// Shared helpers for the gate scripts next to this file: the per-side accept lists
// (accepted-overrides.json, accepted-advisories.json) and `semver`. Both are JSON objects keyed by package directory (backend, web,
// mobile); keys starting with `_` are documentation and are skipped. The side is the basename of
// the current directory, so the scripts run from `<side>/`. Tests point a script at their own
// copy through the environment variable the caller names.
//
// Any failure (file missing or not JSON, run from a directory the list does not name) prints one
// line to stderr prefixed with the calling script's name and exits 2: "the gate could not run",
// never a stack trace.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export function fail(message) {
  process.stderr.write(`${basename(process.argv[1] ?? 'script')}: ${message}\n`);
  process.exit(2);
}

/** @returns {{ side: string, entries: object[], sides: string[], file: string, label: string }} */
export function loadAcceptList(fileName, envVar) {
  const file = process.env[envVar] ?? join(HERE, fileName);
  const rel = relative(ROOT, file);
  const label = rel.startsWith('..') ? file : rel;
  let bySide;
  try {
    bySide = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
  if (bySide === null || typeof bySide !== 'object' || Array.isArray(bySide)) {
    fail(`${label} is not a JSON object keyed by side`);
  }
  const sides = Object.keys(bySide).filter((key) => !key.startsWith('_'));
  const side = basename(process.cwd());
  if (!sides.includes(side)) {
    fail(`run from a package directory (${sides.join(', ')}); cwd is ${process.cwd()}`);
  }
  if (!Array.isArray(bySide[side])) fail(`"${side}" in ${label} is not a list`);
  return { side, entries: bySide[side], sides, file, label };
}

/** `semver` from the current package's node_modules, else npm's bundled copy; exit 2 when neither loads. */
export function loadSemver() {
  try {
    return createRequire(join(process.cwd(), 'package.json'))('semver');
  } catch {
    /* no install in this directory: fall through to npm's own copy */
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, 'npm', 'package.json'))('semver');
  } catch {
    return fail('cannot load semver; run `npm install` in this package first');
  }
}
