#!/usr/bin/env node
/**
 * WorkOS Staging → Production cutover check (#24). READ-ONLY: it never writes
 * to the database or to WorkOS. Runbook: docs/runbooks/workos-production-cutover.md
 *
 * Every live `User` row is linked to a *staging* WorkOS user id until the key
 * switch. After it, `WorkOSService.syncUser` relinks each account by verified
 * email on its next sign-in (branch 3a), so no data change is needed; this
 * script says whether the data is ready for that and, afterwards, how far
 * the relink has got. Produces JSON on stdout, ids only (never an email):
 *
 *   users           live rows: total, linked (holds a workosUserId), linkedAdmins,
 *                   unlinked (pre-provisioned or managed; claims as before),
 *                   linkedUnverified (stored emailVerified false; informational),
 *                   mixedCaseEmail (stored address is not lower-case; matched
 *                   case-insensitively since #955, informational)
 *   caseCollisions  BLOCKING. Groups of live user ids whose emails differ only by
 *                   case. A sign-in for such an address gets 409 (syncUser
 *                   refuses to guess), so resolve every group by hand first.
 *   workos          with --check-workos only: each linked row's workosUserId
 *                   looked up in the WorkOS environment WORKOS_API_KEY belongs to.
 *                   `unknown` rows relink on their next sign-in; `unknownUserIds`
 *                   lists them. Before the switch, run with the staging key and
 *                   expect unknown = 0; after it, with the production key, unknown
 *                   is the number of accounts that have not signed in again yet.
 *
 * Usage (DATABASE_URL in the environment, as the API itself uses it):
 *   node scripts/workos-cutover-check.mjs
 *   node scripts/workos-cutover-check.mjs --check-workos      # also needs WORKOS_API_KEY
 *
 * Exit codes: 0 ready; 2 case collisions found; 3 a WorkOS lookup failed
 * (anything but 200 or 404); 1 the script itself failed. `--no-fail` reports
 * without a non-zero exit for 2 and 3.
 *
 * Connection rules mirror src/models/index.ts and pg-upgrade-checks.mjs: TLS
 * with the pinned RDS CA bundle for anything that is not localhost
 * (`RDS_CA_BUNDLE_PATH` overrides the path). `pg` is resolved from the current
 * working directory's node_modules (ESM ignores NODE_PATH), so inside the
 * one-off ECS task run it from /app: `cd /app && node /tmp/workos-cutover-check.mjs`.
 * `WORKOS_API_URL` overrides https://api.workos.com (tests only).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
let pg;
try {
  pg = require('pg');
} catch {
  console.error(`workos-cutover-check: cannot resolve "pg" from ${process.cwd()} — run from backend/ (or /app in the container)`);
  process.exit(1);
}

const USER_COUNTS = `SELECT
    count(*)::int AS "total",
    count("workosUserId")::int AS "linked",
    count(*) FILTER (WHERE "workosUserId" IS NOT NULL AND "role" = 'ADMIN')::int AS "linkedAdmins",
    count(*) FILTER (WHERE "workosUserId" IS NULL)::int AS "unlinked",
    count(*) FILTER (WHERE "workosUserId" IS NOT NULL AND NOT "emailVerified")::int AS "linkedUnverified",
    count(*) FILTER (WHERE "email" IS NOT NULL AND "email" <> lower("email"))::int AS "mixedCaseEmail"
  FROM "User" WHERE "deletedAt" IS NULL`;

const CASE_COLLISIONS = `SELECT array_agg("id" ORDER BY "id") AS "ids"
  FROM "User"
  WHERE "deletedAt" IS NULL AND "email" IS NOT NULL
  GROUP BY lower(trim("email"))
  HAVING count(*) > 1
  ORDER BY min("id")`;

const LINKED = `SELECT "id", "workosUserId" FROM "User"
  WHERE "deletedAt" IS NULL AND "workosUserId" IS NOT NULL ORDER BY "id"`;

function parseArgs(argv) {
  const args = { checkWorkos: false, fail: true };
  for (const arg of argv) {
    if (arg === '--check-workos') args.checkWorkos = true;
    else if (arg === '--no-fail') args.fail = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function sslConfig(connectionString) {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)) return undefined;
  const caPath = process.env.RDS_CA_BUNDLE_PATH || join(process.cwd(), 'certs', 'rds-global-bundle.pem');
  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

/** 'known' (200), 'unknown' (404) or 'failed' (anything else, including a network error). */
async function lookUpIdentity(baseUrl, apiKey, workosUserId) {
  try {
    const response = await fetch(`${baseUrl}/user_management/users/${encodeURIComponent(workosUserId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 200) return 'known';
    if (response.status === 404) return 'unknown';
    return 'failed';
  } catch {
    return 'failed';
  }
}

async function checkWorkos(linkedRows) {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) throw new Error('--check-workos needs WORKOS_API_KEY');
  const baseUrl = (process.env.WORKOS_API_URL || 'https://api.workos.com').replace(/\/+$/, '');
  const result = {
    environment: apiKey.startsWith('sk_live_') ? 'production' : apiKey.startsWith('sk_test_') ? 'staging' : 'unknown',
    checked: 0,
    known: 0,
    unknown: 0,
    failed: 0,
    unknownUserIds: [],
    failedUserIds: [],
  };
  // Sequential on purpose: a few dozen rows, and no burst against WorkOS rate limits.
  for (const row of linkedRows) {
    const outcome = await lookUpIdentity(baseUrl, apiKey, row.workosUserId);
    result.checked += 1;
    result[outcome] += 1;
    if (outcome === 'unknown') result.unknownUserIds.push(row.id);
    if (outcome === 'failed') result.failedUserIds.push(row.id);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const ssl = sslConfig(connectionString);
  const client = new pg.Client({ connectionString, ...(ssl ? { ssl } : {}) });
  await client.connect();
  let users;
  let caseCollisions;
  let linkedRows;
  try {
    // One snapshot for every query, and nothing in it can write.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    users = (await client.query(USER_COUNTS)).rows[0];
    caseCollisions = (await client.query(CASE_COLLISIONS)).rows.map((row) => row.ids);
    linkedRows = args.checkWorkos ? (await client.query(LINKED)).rows : [];
    await client.query('COMMIT');
  } finally {
    await client.end();
  }

  const report = { collectedAt: new Date().toISOString(), users, caseCollisions };
  const problems = [];
  let exitCode = 0;
  if (caseCollisions.length > 0) {
    problems.push(`${caseCollisions.length} email address(es) held by more than one live account, differing only by case`);
    exitCode = 2;
  }
  if (args.checkWorkos) {
    report.workos = await checkWorkos(linkedRows);
    if (report.workos.failed > 0) {
      problems.push(`${report.workos.failed} WorkOS lookup(s) failed (neither 200 nor 404)`);
      if (exitCode === 0) exitCode = 3;
    }
  }

  report.problems = problems;
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) console.error(`workos-cutover-check: ${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(args.fail ? exitCode : 0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message || error.code || error.name : String(error);
  console.error(`workos-cutover-check: ${message}`);
  process.exit(1);
});
