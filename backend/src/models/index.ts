/**
 * Database models via Prisma Client
 * Import PrismaClient and export configured instance
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL!;

/**
 * RDS enforces TLS (`rds.force_ssl = 1`), and unlike Prisma's old Rust engine,
 * the `@prisma/adapter-pg` driver (node-postgres) does NOT negotiate TLS unless
 * we explicitly enable it — a non-SSL connection is rejected with a `28000`
 * "no pg_hba.conf entry ... no encryption" error that Prisma surfaces as the
 * misleading "P1010 denied access". Local dev Postgres (docker-compose) has no
 * TLS, so SSL is skipped for localhost. `rejectUnauthorized: false` keeps the
 * connection encrypted without pinning the RDS CA bundle (the app runs inside a
 * private VPC); see follow-up to pin the Amazon RDS CA for full verification.
 */
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

const adapter = new PrismaPg({
  connectionString,
  ...(isLocalDb ? {} : { ssl: { rejectUnauthorized: false } }),
});

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;

