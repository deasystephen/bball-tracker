/**
 * The guard in front of `npm run db:reset` / `db:fresh` (#784).
 *
 * Runs in the default `npm test`: it imports only `prisma/reset-guard.ts`,
 * which constructs no Prisma client. The last block reads `prisma/reset.ts`
 * as text and checks the guard is called before the first `deleteMany`, so a
 * refactor cannot quietly move it.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { assertResetAllowed, databaseHost, LOCAL_DATABASE_HOSTS } from '../../prisma/reset-guard';

const RDS_URL = 'postgresql://u:p@bball-tracker-prod.abc123.us-east-1.rds.amazonaws.com:5432/app';
const LOCAL_URL = 'postgresql://postgres:postgres@localhost:5432/bball_tracker?schema=public';

describe('assertResetAllowed refuses', () => {
  it.each([
    ['NODE_ENV=production on a local database', { NODE_ENV: 'production', DATABASE_URL: LOCAL_URL }],
    ['an RDS host with NODE_ENV unset', { DATABASE_URL: RDS_URL }],
    ['an RDS host with NODE_ENV=development', { NODE_ENV: 'development', DATABASE_URL: RDS_URL }],
    ['an RDS host in upper case', { DATABASE_URL: RDS_URL.toUpperCase() }],
  ])('%s', (_label, env) => {
    expect(() => assertResetAllowed(env as NodeJS.ProcessEnv)).toThrow(
      'Refusing to reset: NODE_ENV=production or DATABASE_URL points at an RDS host'
    );
  });

  it.each([
    ['DATABASE_URL unset', {}],
    ['DATABASE_URL empty', { DATABASE_URL: '' }],
  ])('%s', (_label, env) => {
    expect(() => assertResetAllowed(env as NodeJS.ProcessEnv)).toThrow('Refusing to reset: DATABASE_URL is not set');
  });

  it('a DATABASE_URL that is not a URL', () => {
    expect(() => assertResetAllowed({ DATABASE_URL: 'not a url' } as NodeJS.ProcessEnv)).toThrow(
      'Refusing to reset: DATABASE_URL is not a URL this guard can read'
    );
  });

  it.each([
    ['a remote host that is not RDS', 'postgresql://u:p@db.example.test:5432/app'],
    ['a managed Postgres host', 'postgresql://u:p@ep-cool-name.us-east-2.aws.neon.tech/app'],
    ['a host that merely starts with localhost', 'postgresql://u:p@localhost.example.test:5432/app'],
    ['a LAN address', 'postgresql://u:p@192.168.1.20:5432/app'],
  ])('%s', (_label, DATABASE_URL) => {
    expect(() => assertResetAllowed({ DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(
      /Refusing to reset: DATABASE_URL host ".*" is not a local database/
    );
  });

  it('with no override: SEED_ALLOW_PRODUCTION does not apply to a reset', () => {
    const env = { DATABASE_URL: RDS_URL, SEED_ALLOW_PRODUCTION: 'true' } as NodeJS.ProcessEnv;
    expect(() => assertResetAllowed(env)).toThrow('There is no override');
  });
});

describe('assertResetAllowed allows', () => {
  it.each([
    ['localhost with NODE_ENV unset', { DATABASE_URL: LOCAL_URL }],
    ['localhost with NODE_ENV=development', { NODE_ENV: 'development', DATABASE_URL: LOCAL_URL }],
    ['localhost with NODE_ENV=test', { NODE_ENV: 'test', DATABASE_URL: LOCAL_URL }],
    ['127.0.0.1', { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/bball_tracker' }],
    ['IPv6 loopback', { DATABASE_URL: 'postgresql://postgres:postgres@[::1]:5432/bball_tracker' }],
    ['the docker-compose service name', { DATABASE_URL: 'postgresql://postgres:postgres@postgres:5432/bball_tracker' }],
    ['a local URL with no credentials', { DATABASE_URL: 'postgresql://localhost/bball_tracker' }],
  ])('%s', (_label, env) => {
    expect(() => assertResetAllowed(env as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('databaseHost', () => {
  it.each([
    [LOCAL_URL, 'localhost'],
    ['postgresql://u:p@[::1]:5432/app', '[::1]'],
    ['postgresql://u:p@DB.ABC.US-EAST-1.RDS.AMAZONAWS.COM/app', 'db.abc.us-east-1.rds.amazonaws.com'],
    ['not a url', null],
    ['', null],
  ])('%s → %s', (url, host) => {
    expect(databaseHost(url)).toBe(host);
  });

  it('the allowlist is only loopback and the compose service', () => {
    expect(LOCAL_DATABASE_HOSTS).toEqual(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);
  });
});

describe('prisma/reset.ts', () => {
  const source = readFileSync(path.resolve(__dirname, '../../prisma/reset.ts'), 'utf8');

  it('calls the guard before its first deleteMany', () => {
    const guardAt = source.indexOf('assertResetAllowed()');
    const firstDeleteAt = source.indexOf('.deleteMany(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstDeleteAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstDeleteAt);
  });

  it('constructs the Prisma client only after the guard', () => {
    expect(source.indexOf('assertResetAllowed()')).toBeLessThan(source.indexOf('new PrismaClient('));
  });

  it('reads no override variable', () => {
    expect(source).not.toMatch(/ALLOW_PRODUCTION|FORCE|--yes/);
  });
});
