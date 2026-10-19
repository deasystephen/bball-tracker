#!/usr/bin/env node
// Audit floor gate (#924): fails when the production dependency tree of the current package
// directory (backend/, web/ or mobile/) carries a high or critical advisory that is not listed for
// that directory in accepted-advisories.json (same directory as this script). It is the check that
// would have stopped #919, which dropped a security override, resolved deepmerge-ts back to 7.1.5
// under GHSA-ggr8-5vv4-36mx, passed every other gate and deployed unattended.
//
//   node ../.github/scripts/check-audit-floor.mjs                 # runs npm audit --omit=dev --json
//   node ../.github/scripts/check-audit-floor.mjs --report a.json # reads a saved report (tests)
//
// npm audit has no allow-list of its own, so this reads its JSON: every advisory object in a
// vulnerability's `via` list, one per (GHSA id at the end of its URL, package). An allow-list entry
// matches on `ghsa` AND `package`, and pins the vulnerable `range` and `severity` it was reviewed
// against (like `gets` in accepted-overrides.json): when npm audit reports a different range (as a
// semver set, not a string) or severity, the advisory has moved or been re-scored and it FAILs
// until a human re-reviews the entry.
//
// An accepted entry also FAILs when npm reports a reachable fix (`fixAvailable` true, or a
// non-major parent change): a patch was published, so apply it and retire the entry. An advisory
// npm reports without a GitHub URL is keyed `npm-<source id>`; an entry lists it under that id.
//
// Output: one `FAIL`, `accepted` or `stale` line per advisory or entry. Exit 0 when nothing fails,
// 1 when something fails, 2 when the gate could not run (no network, npm missing, unreadable
// file): it fails closed. Tests point it at their own list through ACCEPTED_ADVISORIES_FILE.
// Rules: docs/automation/daily-upgrade-scan.md, "Audit floor gate".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fail, loadAcceptList, loadSemver } from './accept-list.mjs';

const FAILING = new Set(['high', 'critical']);

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--report')) {
  fail('usage: check-audit-floor.mjs [--report <npm-audit.json>]');
}
const { side, entries, label } = loadAcceptList('accepted-advisories.json', 'ACCEPTED_ADVISORIES_FILE');

let raw;
if (args[0] === '--report') {
  try {
    raw = readFileSync(args[1], 'utf8');
  } catch (error) {
    fail(`cannot read the report ${args[1]}: ${error.message}`);
  }
} else {
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (error) {
    // npm audit exits 1 whenever it finds anything; the JSON is still on stdout.
    if (typeof error.stdout !== 'string' || error.stdout.trim() === '') {
      const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
      fail(`npm audit produced no output (${error.code ?? `exit ${error.status ?? error.signal}`})${stderr ? `: ${stderr}` : ''}`);
    }
    if (typeof error.stderr === 'string' && error.stderr.trim()) process.stderr.write(error.stderr);
    raw = error.stdout;
  }
}
let report;
try {
  report = JSON.parse(raw);
} catch {
  fail(`npm audit did not return JSON: ${String(raw).slice(0, 200)}`);
}
if (report.error || !report.vulnerabilities) {
  // npm's own failure body is { message, error: { summary: '', detail: '' } }: empty strings, so `||`.
  const detail = report.message || report.error?.summary || JSON.stringify(report.error ?? report);
  const code = report.error?.code ? ` [${report.error.code}]` : '';
  fail(`npm audit failed${code}: ${detail}${report.error?.detail ? ` (${report.error.detail})` : ''}`);
}

// The GHSA id anywhere in the advisory URL (github.com/advisories/GHSA-…, with or without a
// trailing slash); otherwise (a legacy npmjs.com advisory URL, or none) npm's numeric source id.
const ghsaOf = (via) => {
  const match = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(String(via.url ?? ''));
  return match ? match[0] : `npm-${via.source}`;
};
// Ranges compare as version sets, so a re-formatting npm or GitHub applies to the same range
// (`<=3.0.3` vs `<= 3.0.3`, or reordered `||` sets) is not "moved". semver loads only when an
// accepted entry's range string differs.
let semver;
function sameRange(a, b) {
  if (a === b) return true;
  semver ??= loadSemver();
  try {
    const options = { includePrerelease: true };
    return semver.subset(a, b, options) && semver.subset(b, a, options);
  } catch {
    return false; // an unparseable range is never "the same"
  }
}
// Every advisory object at any severity, keyed (id, package): an accepted advisory that npm now
// reports at moderate must read as downgraded, not as gone.
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities)) {
  for (const via of vulnerability.via) {
    if (typeof via === 'object') advisories.set(`${ghsaOf(via)} ${via.name}`, via);
  }
}
// npm's fixAvailable for the vulnerable package: `true` (npm audit fix reaches a patched version
// inside the declared ranges) or `{ name, version, isSemVerMajor }` (change that parent). A
// semver-major parent change is npm's suggestion even when no patched version exists (on
// 2026-10-18 it proposed jest 30.5.2 for braces and expo-updates 0.11.7, a downgrade, for
// node-forge), so only `true` or a non-major parent change counts as "a patch is reachable".
function reachableFix(packageName) {
  const fix = report.vulnerabilities[packageName]?.fixAvailable;
  if (fix === true) return 'npm audit fix resolves it within the declared ranges';
  if (fix && typeof fix === 'object' && fix.isSemVerMajor === false) return `${fix.name}@${fix.version} (not semver-major) resolves it`;
  return null;
}

const entryKey = (entry) => `${entry.ghsa} ${entry.package}`;
const accepted = new Map();
for (const entry of entries) {
  if (accepted.has(entryKey(entry))) fail(`duplicate entry for ${entryKey(entry)} under "${side}" in ${label}`);
  accepted.set(entryKey(entry), entry);
}

let failed = 0;
for (const [key, via] of [...advisories].sort(([a], [b]) => a.localeCompare(b))) {
  if (!FAILING.has(via.severity)) continue;
  const id = ghsaOf(via);
  const where = `${via.name} ${via.range} (${via.severity}): ${via.title}`;
  const entry = accepted.get(key);
  const fix = reachableFix(via.name);
  if (!entry) {
    failed += 1;
    const listAs = id.startsWith('npm-') ? ` (no GHSA id in the advisory URL: an allow-list entry for it uses "ghsa": "${id}")` : '';
    process.stdout.write(`FAIL ${id} ${where} ${via.url ?? ''}${listAs}\n`);
  } else if (fix) {
    failed += 1;
    process.stdout.write(
      `FAIL ${id} ${via.name}: a patched version exists (${fix}); apply it and remove the entry from ${label} (${via.url ?? ''})\n`,
    );
  } else if (!sameRange(entry.range, via.range)) {
    failed += 1;
    process.stdout.write(
      `FAIL ${id} ${via.name}: the advisory moved. ${label} accepts range "${entry.range}" but npm audit now reports "${via.range}"; ` +
        `a patched version has usually been published: apply it, or re-review the entry and update its range (${via.url ?? ''})\n`,
    );
  } else if (entry.severity !== via.severity) {
    failed += 1;
    process.stdout.write(
      `FAIL ${id} ${via.name}: the advisory was re-scored. ${label} accepts severity "${entry.severity}" but npm audit now reports "${via.severity}"; ` +
        `re-review the entry and update its severity, or apply a fix (${via.url ?? ''})\n`,
    );
  } else {
    process.stdout.write(`accepted ${id} ${where} (${label})\n`);
  }
}
for (const [key, entry] of accepted) {
  const via = advisories.get(key);
  if (!via) {
    process.stdout.write(
      `stale ${entry.ghsa} ${entry.package} is listed for ${side} in ${label} but npm audit no longer reports it for that package\n`,
    );
  } else if (!FAILING.has(via.severity)) {
    process.stdout.write(
      `stale ${entry.ghsa} ${entry.package} is listed for ${side} in ${label} but npm audit now reports it at ${via.severity}, below the gate\n`,
    );
  }
}
if (failed > 0) {
  process.stdout.write(
    `\n${failed} high or critical advisor${failed === 1 ? 'y' : 'ies'} failed in ${side}'s production dependencies. ` +
      `Lift the resolved version above the advisory's first patched version (an overrides entry, docs/automation/daily-upgrade-scan.md "Override shape"), ` +
      `or, only when no patched version exists, list it for ${side} in ${label} in a reviewed PR.\n`,
  );
  process.exit(1);
}
process.stdout.write(`audit floor ok: no unaccepted high or critical advisory in ${side}'s production dependencies\n`);
