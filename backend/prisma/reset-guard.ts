/**
 * The guard in front of `npm run db:reset` and `npm run db:fresh` (#784).
 *
 * `prisma/reset.ts` deletes every row in every table. Its original check was
 * `NODE_ENV === 'production'` alone, and the repo already decided (seed.ts,
 * tests/support/test-leftovers.ts) that this one signal is not enough: the
 * realistic accident is a local shell with `NODE_ENV` unset and `DATABASE_URL`
 * exported for production, which is exactly the shell the data-subject and
 * RDS runbooks tell the operator to open.
 *
 * Three refusals, in order, and no environment variable overrides any of them
 * (the seed's `SEED_ALLOW_PRODUCTION` exists because seeding has a conceivable
 * production use; a full wipe has none):
 *
 *   1. `NODE_ENV=production`, or `DATABASE_URL` names an RDS host — the same
 *      two signals as the seed, via `assertNotProductionDatabase`.
 *   2. `DATABASE_URL` is unset or unparsable — nothing to reason about.
 *   3. The host is not one of the local names below — a wipe has no remote use.
 *
 * Kept free of Prisma imports so a Jest test can load it without constructing
 * a client; `tests/prisma/reset-guard.test.ts` covers every branch and also
 * checks that `reset.ts` calls it before its first `deleteMany`.
 */

import { assertNotProductionDatabase } from '../tests/support/test-leftovers';

/** Hosts a reset may touch: loopback and the docker-compose service name. */
export const LOCAL_DATABASE_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'];

/** The lower-cased host of a connection URL, or `null` when it cannot be parsed. */
export function databaseHost(databaseUrl: string): string | null {
  try {
    const host = new URL(databaseUrl).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** Throws unless `env` describes a local development or test database. */
export function assertResetAllowed(env: NodeJS.ProcessEnv = process.env): void {
  try {
    assertNotProductionDatabase(env);
  } catch {
    throw new Error(
      'Refusing to reset: NODE_ENV=production or DATABASE_URL points at an RDS host. There is no override.'
    );
  }

  const databaseUrl = env.DATABASE_URL ?? '';
  if (databaseUrl.length === 0) {
    throw new Error('Refusing to reset: DATABASE_URL is not set.');
  }

  const host = databaseHost(databaseUrl);
  if (host === null) {
    throw new Error('Refusing to reset: DATABASE_URL is not a URL this guard can read.');
  }
  if (!LOCAL_DATABASE_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to reset: DATABASE_URL host "${host}" is not a local database ` +
        `(${LOCAL_DATABASE_HOSTS.join(', ')}). There is no override.`
    );
  }
}
