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
// vulnerability's `via` list, keyed by the GHSA id at the end of its URL. Output: one `FAIL`,
// `accepted` or `stale` line per advisory. Exit 0 when nothing fails, 1 when an advisory fails,
// 2 when the audit itself could not run (no network, bad report): the gate fails closed.
// Tests point it at their own allow-list through ACCEPTED_ADVISORIES_FILE.
// Rules: docs/automation/daily-upgrade-scan.md, "Audit floor gate".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAILING = new Set(['high', 'critical']);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOW_FILE =
  process.env.ACCEPTED_ADVISORIES_FILE ?? join(dirname(fileURLToPath(import.meta.url)), 'accepted-advisories.json');
const ALLOW_NAME = relative(ROOT, ALLOW_FILE).startsWith('..') ? ALLOW_FILE : relative(ROOT, ALLOW_FILE);

function die(message) {
  process.stderr.write(`check-audit-floor: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const reportAt = args.indexOf('--report');
if (args.length !== 0 && !(args.length === 2 && reportAt === 0)) {
  die('usage: check-audit-floor.mjs [--report <npm-audit.json>]');
}

const side = basename(process.cwd());
const allowList = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'));
if (!Array.isArray(allowList[side])) die(`no "${side}" key in ${ALLOW_NAME}; run from backend/, web/ or mobile/`);
const accepted = new Map(allowList[side].map((entry) => [entry.ghsa, entry]));

let raw;
if (reportAt === 0) {
  raw = readFileSync(args[1], 'utf8');
} else {
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (error) {
    raw = error.stdout; // npm audit exits 1 whenever it finds anything; the JSON is still on stdout
  }
}
let report;
try {
  report = JSON.parse(raw);
} catch {
  die('npm audit did not return JSON');
}
if (report.error || !report.vulnerabilities) die(`npm audit failed: ${JSON.stringify(report.error ?? report)}`);

const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities)) {
  for (const via of vulnerability.via) {
    if (typeof via !== 'object' || !FAILING.has(via.severity)) continue;
    const id = String(via.url ?? '').split('/').pop() || `npm-${via.source}`;
    advisories.set(id, via);
  }
}

let failed = 0;
for (const [id, via] of [...advisories].sort(([a], [b]) => a.localeCompare(b))) {
  const where = `${via.name} ${via.range} (${via.severity}): ${via.title}`;
  if (accepted.has(id)) {
    process.stdout.write(`accepted ${id} ${where} (${ALLOW_NAME})\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL ${id} ${where} ${via.url ?? ''}\n`);
  }
}
for (const id of accepted.keys()) {
  if (!advisories.has(id)) process.stdout.write(`stale ${id} is listed for ${side} in ${ALLOW_NAME} but npm audit no longer reports it\n`);
}
if (failed > 0) {
  process.stdout.write(
    `\n${failed} high or critical advisor${failed === 1 ? 'y' : 'ies'} in ${side}'s production dependencies. ` +
      `Lift the resolved version above the advisory's first patched version (an overrides entry, docs/automation/daily-upgrade-scan.md "Override shape"), ` +
      `or, only when no patched version exists, list it for ${side} in ${ALLOW_NAME} in a reviewed PR.\n`,
  );
  process.exit(1);
}
process.stdout.write(`audit floor ok: no unaccepted high or critical advisory in ${side}'s production dependencies\n`);
