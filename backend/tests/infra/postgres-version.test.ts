/**
 * Config-bound test over the PostgreSQL major version (#521).
 *
 * The major is written in three machine-consumed files that cannot share a
 * constant: `infra/rds.tf` (production, major-only pin), `docker-compose.yml`
 * (local dev) and `.github/workflows/ci.yml` (the Postgres the whole backend
 * suite — including the real-database `league-access.db.test.ts` — runs on).
 * If they drift, CI validates migrations against an engine production does not
 * run. This suite fails on any disagreement, and every extraction must succeed
 * (a file that changed shape fails loudly rather than passing vacuously).
 *
 * It also carries a DELIBERATE dated assertion: RDS ends standard support for
 * each major on a published date, after which Extended Support bills
 * automatically (or, with `engine_lifecycle_support` disabled, RDS upgrades the
 * major unattended — neither warns). This test goes red six months before that
 * date so the upgrade is scheduled while there is still time. On that day the
 * fix is the upgrade itself (runbook: "Major version upgrade"), then a one-line
 * edit to the table below. Do not "fix" it by widening the window.
 *
 * Dates: https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html
 */
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const RDS_TF = path.join(ROOT, 'infra/rds.tf');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const CI_WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');

const RELEASE_CALENDAR_URL =
  'https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html';

/** RDS end of standard support per major (verified against the calendar 2026-09-07). */
export const END_OF_STANDARD_SUPPORT: Readonly<Record<string, string>> = {
  '15': '2028-02-29',
  '16': '2029-02-28',
  '17': '2030-02-28',
  '18': '2031-02-28',
};

/** How far ahead of the end-of-support date this suite starts failing. */
export const WARNING_MONTHS = 6;

export const RDS_PATTERN = /^\s*engine_version\s*=\s*"(\d+)"\s*$/m;
export const COMPOSE_PATTERN = /^\s*image:\s*postgres:(\d+)-alpine\s*$/m;
export const CI_PATTERN = /^\s*image:\s*postgres:(\d+)\s*$/m;

export function extractMajor(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(
      `${label}: could not find the PostgreSQL major with ${pattern}. ` +
        'If the file changed shape, update the pattern in tests/infra/postgres-version.test.ts — ' +
        'do not let this test pass vacuously.',
    );
  }
  return match[1];
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function readMajors(): { rds: string; compose: string; ci: string } {
  return {
    rds: extractMajor(readFileSync(RDS_TF, 'utf8'), RDS_PATTERN, 'infra/rds.tf'),
    compose: extractMajor(readFileSync(COMPOSE, 'utf8'), COMPOSE_PATTERN, 'docker-compose.yml'),
    ci: extractMajor(readFileSync(CI_WORKFLOW, 'utf8'), CI_PATTERN, '.github/workflows/ci.yml'),
  };
}

describe('PostgreSQL major version — rds.tf / docker-compose / CI parity', () => {
  const majors = readMajors();

  it('pins the same major in production, local dev and CI', () => {
    expect(majors.compose).toBe(majors.rds);
    expect(majors.ci).toBe(majors.rds);
  });

  it('pins a major that RDS still supports, with at least six months of standard support left', () => {
    const endOfSupport = END_OF_STANDARD_SUPPORT[majors.rds];
    if (endOfSupport === undefined) {
      throw new Error(
        `PostgreSQL ${majors.rds} has no end-of-standard-support date in END_OF_STANDARD_SUPPORT. ` +
          `Add it from ${RELEASE_CALENDAR_URL}.`,
      );
    }
    const deadline = new Date(`${endOfSupport}T00:00:00Z`);
    const horizon = addMonths(new Date(), WARNING_MONTHS);
    if (horizon >= deadline) {
      throw new Error(
        `PostgreSQL ${majors.rds} leaves RDS standard support on ${endOfSupport}, which is less than ` +
          `${WARNING_MONTHS} months away. Schedule the major version upgrade now: see #521 and ` +
          'docs/runbooks/rds-backup-restore.md, section "Major version upgrade" (if downtime now matters, ' +
          'use RDS Blue/Green instead of the in-place procedure). After upgrading, bump the major in ' +
          `infra/rds.tf, docker-compose.yml and .github/workflows/ci.yml and add the new date from ${RELEASE_CALENDAR_URL}.`,
      );
    }
  });
});

describe('PostgreSQL major version — extraction self-test', () => {
  it('reads the majors the files currently declare', () => {
    expect(extractMajor('  engine_version             = "18"\n', RDS_PATTERN, 'rds')).toBe('18');
    expect(extractMajor('    image: postgres:18-alpine\n', COMPOSE_PATTERN, 'compose')).toBe('18');
    expect(extractMajor('        image: postgres:18\n', CI_PATTERN, 'ci')).toBe('18');
  });

  it('refuses shapes that are not a bare major', () => {
    expect(() => extractMajor('engine_version = "18.6"', RDS_PATTERN, 'rds')).toThrow(/could not find/);
    expect(() => extractMajor('image: postgres:latest', COMPOSE_PATTERN, 'compose')).toThrow(/could not find/);
    expect(() => extractMajor('image: postgres:18.6', CI_PATTERN, 'ci')).toThrow(/could not find/);
    expect(() => extractMajor('image: postgres:18-alpine', CI_PATTERN, 'ci')).toThrow(/could not find/);
  });

  it('adds months without drifting across year boundaries', () => {
    expect(addMonths(new Date('2030-08-28T00:00:00Z'), 6).toISOString()).toBe('2031-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2030-09-01T00:00:00Z'), 6).toISOString()).toBe('2031-03-01T00:00:00.000Z');
  });

  it('would fail six months before the pinned end-of-support date', () => {
    // Mirrors the production assertion with a fixed clock so the boundary is pinned.
    const deadline = new Date(`${END_OF_STANDARD_SUPPORT['18']}T00:00:00Z`);
    expect(addMonths(new Date('2030-08-27T00:00:00Z'), WARNING_MONTHS) >= deadline).toBe(false);
    expect(addMonths(new Date('2030-08-28T00:00:00Z'), WARNING_MONTHS) >= deadline).toBe(true);
  });
});
