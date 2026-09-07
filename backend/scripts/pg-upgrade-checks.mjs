#!/usr/bin/env node
/**
 * PostgreSQL major-upgrade checks (#521).
 *
 * Run BEFORE and AFTER an RDS major version upgrade — on the rehearsal copy and
 * on production — and compare the two outputs. Produces JSON on stdout:
 *
 *   version      — `SELECT version()`
 *   prechecks    — AWS's own pre-upgrade blockers (all must be empty / zero):
 *                  prepared transactions, reg* column types, logical replication
 *                  slots, installed extensions (plpgsql only), large objects,
 *                  invalid databases
 *   rowCounts    — per-table counts for the core tables (must match after)
 *   collation    — datcollversion vs pg_database_collation_actual_version for the
 *                  current database. A mismatch after the upgrade means the OS
 *                  glibc moved and every text index (User.email, Team.name,
 *                  invitation tokens) can mis-order silently until
 *                  `REINDEX DATABASE` + `ALTER DATABASE … REFRESH COLLATION VERSION`.
 *
 * Usage (DATABASE_URL in the environment, as the API itself uses it):
 *   node scripts/pg-upgrade-checks.mjs                 > before.json
 *   node scripts/pg-upgrade-checks.mjs --compare before.json   # after the upgrade
 *
 * Exit codes: 0 clean; 2 a precheck is not clean; 3 --compare found a
 * difference in row counts or a collation-version mismatch. `--no-fail` reports
 * without a non-zero exit.
 *
 * Connection rules mirror src/models/index.ts: TLS with the pinned RDS CA
 * bundle for anything that is not localhost (`RDS_CA_BUNDLE_PATH` overrides the
 * path). Inside the one-off ECS task (runbook variant) run it as
 * `NODE_PATH=/app/node_modules node /tmp/pg-upgrade-checks.mjs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const CORE_TABLES = ['User', 'Team', 'TeamLineage', 'Game', 'GameEvent', 'PlayerStats', 'TeamInvitation'];

const PRECHECKS = {
  preparedTransactions: 'SELECT count(*)::int AS count FROM pg_catalog.pg_prepared_xacts',
  regTypeColumns: `SELECT n.nspname, c.relname, a.attname
    FROM pg_catalog.pg_class c, pg_catalog.pg_namespace n, pg_catalog.pg_attribute a
    WHERE c.oid = a.attrelid AND NOT a.attisdropped
      AND a.atttypid IN ('pg_catalog.regproc'::pg_catalog.regtype,
                         'pg_catalog.regprocedure'::pg_catalog.regtype,
                         'pg_catalog.regoper'::pg_catalog.regtype,
                         'pg_catalog.regoperator'::pg_catalog.regtype,
                         'pg_catalog.regconfig'::pg_catalog.regtype,
                         'pg_catalog.regdictionary'::pg_catalog.regtype)
      AND c.relnamespace = n.oid
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  logicalReplicationSlots: `SELECT slot_name, plugin, database
    FROM pg_replication_slots WHERE slot_type <> 'physical'`,
  extensions: 'SELECT extname, extversion FROM pg_extension ORDER BY extname',
  largeObjects: 'SELECT count(*)::int AS count FROM pg_largeobject_metadata',
  invalidDatabases: 'SELECT datname FROM pg_database WHERE datconnlimit = -2',
};

const EXPECTED_EXTENSIONS = ['plpgsql'];

function parseArgs(argv) {
  const args = { compare: null, fail: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--compare') {
      args.compare = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--no-fail') {
      args.fail = false;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function sslConfig(connectionString) {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)) return undefined;
  const caPath = process.env.RDS_CA_BUNDLE_PATH || join(process.cwd(), 'certs', 'rds-global-bundle.pem');
  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

async function collect(client) {
  const version = (await client.query('SELECT version() AS version')).rows[0].version;

  const prechecks = {};
  for (const [name, sql] of Object.entries(PRECHECKS)) {
    prechecks[name] = (await client.query(sql)).rows;
  }

  const rowCounts = {};
  for (const table of CORE_TABLES) {
    rowCounts[table] = (await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows[0].count;
  }

  const collation = (
    await client.query(`SELECT datname, datcollate, datcollversion,
        pg_database_collation_actual_version(oid) AS actual_version
      FROM pg_database WHERE datname = current_database()`)
  ).rows[0];

  return { collectedAt: new Date().toISOString(), version, prechecks, rowCounts, collation };
}

function precheckProblems(prechecks) {
  const problems = [];
  if (prechecks.preparedTransactions[0].count !== 0) problems.push('open prepared transactions');
  if (prechecks.regTypeColumns.length > 0) problems.push('reg* column types in user tables');
  if (prechecks.logicalReplicationSlots.length > 0) problems.push('logical replication slots present');
  const unexpected = prechecks.extensions.map((e) => e.extname).filter((n) => !EXPECTED_EXTENSIONS.includes(n));
  if (unexpected.length > 0) problems.push(`unexpected extensions: ${unexpected.join(', ')}`);
  if (prechecks.largeObjects[0].count !== 0) problems.push('large objects present');
  if (prechecks.invalidDatabases.length > 0) problems.push('invalid databases present');
  return problems;
}

function collationProblems(collation) {
  if (collation.datcollversion == null || collation.actual_version == null) return [];
  if (collation.datcollversion !== collation.actual_version) {
    return [
      `collation version mismatch for ${collation.datname}: recorded ${collation.datcollversion}, ` +
        `actual ${collation.actual_version} — run REINDEX DATABASE and ALTER DATABASE … REFRESH COLLATION VERSION`,
    ];
  }
  return [];
}

function compareProblems(before, after) {
  const problems = [];
  for (const table of CORE_TABLES) {
    if (before.rowCounts[table] !== after.rowCounts[table]) {
      problems.push(`row count changed for ${table}: ${before.rowCounts[table]} → ${after.rowCounts[table]}`);
    }
  }
  if (before.collation.datcollate !== after.collation.datcollate) {
    problems.push(`datcollate changed: ${before.collation.datcollate} → ${after.collation.datcollate}`);
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const ssl = sslConfig(connectionString);
  const client = new pg.Client({ connectionString, ...(ssl ? { ssl } : {}) });
  await client.connect();
  let report;
  try {
    report = await collect(client);
  } finally {
    await client.end();
  }

  const problems = [...precheckProblems(report.prechecks), ...collationProblems(report.collation)];
  let exitCode = problems.length > 0 ? 2 : 0;

  if (args.compare) {
    const before = JSON.parse(readFileSync(args.compare, 'utf8'));
    const diffs = compareProblems(before, report);
    report.comparedTo = { file: args.compare, collectedAt: before.collectedAt, version: before.version };
    problems.push(...diffs);
    if (diffs.length > 0) exitCode = 3;
  }

  report.problems = problems;
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) console.error(`pg-upgrade-checks: ${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(args.fail ? exitCode : 0);
}

main().catch((error) => {
  console.error(`pg-upgrade-checks: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
