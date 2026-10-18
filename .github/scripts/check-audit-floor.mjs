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
// matches on `ghsa` AND `package`, and pins the vulnerable `range` it was reviewed against (like
// `gets` in accepted-overrides.json): when npm audit reports a different range the advisory has
// moved (usually a patch was published) and it FAILs until a human re-reviews the entry.
//
// Output: one `FAIL`, `accepted` or `stale` line per advisory or entry. Exit 0 when nothing fails,
// 1 when something fails, 2 when the gate could not run (no network, npm missing, unreadable
// file): it fails closed. Tests point it at their own list through ACCEPTED_ADVISORIES_FILE.
// Rules: docs/automation/daily-upgrade-scan.md, "Audit floor gate".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fail, loadAcceptList } from './accept-list.mjs';

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
  const detail = report.message ?? report.error?.summary ?? JSON.stringify(report.error ?? report);
  fail(`npm audit failed: ${detail}${report.error?.detail ? ` (${report.error.detail})` : ''}`);
}

const ghsaOf = (via) => String(via.url ?? '').split('/').pop() || `npm-${via.source}`;
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities)) {
  for (const via of vulnerability.via) {
    if (typeof via !== 'object' || !FAILING.has(via.severity)) continue;
    advisories.set(`${ghsaOf(via)} ${via.name}`, via);
  }
}
const entryKey = (entry) => `${entry.ghsa} ${entry.package}`;
const accepted = new Map(entries.map((entry) => [entryKey(entry), entry]));

let failed = 0;
for (const [key, via] of [...advisories].sort(([a], [b]) => a.localeCompare(b))) {
  const id = ghsaOf(via);
  const where = `${via.name} ${via.range} (${via.severity}): ${via.title}`;
  const entry = accepted.get(key);
  if (!entry) {
    failed += 1;
    process.stdout.write(`FAIL ${id} ${where} ${via.url ?? ''}\n`);
  } else if (entry.range !== via.range) {
    failed += 1;
    process.stdout.write(
      `FAIL ${id} ${via.name}: the advisory moved. ${label} accepts range "${entry.range}" but npm audit now reports "${via.range}"; ` +
        `a patched version has usually been published: apply it, or re-review the entry and update its range (${via.url ?? ''})\n`,
    );
  } else {
    process.stdout.write(`accepted ${id} ${where} (${label})\n`);
  }
}
for (const [key, entry] of accepted) {
  if (!advisories.has(key)) {
    process.stdout.write(
      `stale ${entry.ghsa} ${entry.package} is listed for ${side} in ${label} but npm audit no longer reports it for that package\n`,
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
