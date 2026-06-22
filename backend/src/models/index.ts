/**
 * Database models via Prisma Client
 * Import PrismaClient and export configured instance
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';

const connectionString = process.env.DATABASE_URL!;

/**
 * RDS enforces TLS (`rds.force_ssl = 1`), and unlike Prisma's old Rust engine,
 * the `@prisma/adapter-pg` driver (node-postgres) does NOT negotiate TLS unless
 * we explicitly enable it — a non-SSL connection is rejected with a `28000`
 * "no pg_hba.conf entry ... no encryption" error that Prisma surfaces as the
 * misleading "P1010 denied access". Local dev Postgres (docker-compose) has no
 * TLS, so SSL is skipped for localhost.
 */
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

/**
 * For remote (RDS) connections, verify the server certificate against the
 * pinned Amazon RDS global CA bundle. Node's default trust store does NOT
 * include the RDS CAs, so `rejectUnauthorized: true` requires us to supply the
 * bundle explicitly — otherwise the connection fails. The path is resolved from
 * the process cwd (`/app` in the container, `backend/` in local dev, both of
 * which contain `certs/`) and is overridable via `RDS_CA_BUNDLE_PATH`. The
 * bundle is refreshed from
 * https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem.
 */
function getSslConfig(): PoolConfig['ssl'] {
  if (isLocalDb) return undefined;
  const caPath =
    process.env.RDS_CA_BUNDLE_PATH || join(process.cwd(), 'certs', 'rds-global-bundle.pem');
  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

const ssl = getSslConfig();

const adapter = new PrismaPg({
  connectionString,
  ...(ssl ? { ssl } : {}),
});

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;

