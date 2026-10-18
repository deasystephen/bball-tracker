// Shared loader for the per-side accept lists next to this file (accepted-overrides.json,
// accepted-advisories.json). Both are JSON objects keyed by package directory (backend, web,
// mobile); keys starting with `_` are documentation and are skipped. The side is the basename of
// the current directory, so the scripts run from `<side>/`. Tests point a script at their own
// copy through the environment variable the caller names.
//
// Any failure (file missing or not JSON, run from a directory the list does not name) prints one
// line to stderr prefixed with the calling script's name and exits 2: "the gate could not run",
// never a stack trace.
import { readFileSync } from 'node:fs';
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
  const sides = Object.keys(bySide).filter((key) => !key.startsWith('_'));
  const side = basename(process.cwd());
  if (!sides.includes(side)) {
    fail(`run from a package directory (${sides.join(', ')}); cwd is ${process.cwd()}`);
  }
  if (!Array.isArray(bySide[side])) fail(`"${side}" in ${label} is not a list`);
  return { side, entries: bySide[side], sides, file, label };
}
