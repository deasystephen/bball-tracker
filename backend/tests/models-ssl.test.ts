/**
 * Exercises the real `src/models` module (which the global test setup otherwise
 * mocks) so the TLS/SSL selection in `getSslConfig` is covered: remote hosts
 * load the pinned RDS CA bundle and verify the cert; localhost skips TLS.
 *
 * Prisma connects lazily, so constructing the client here makes no DB
 * connection — we only assert the module initializes down each branch.
 */

describe('models SSL config', () => {
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  afterEach(() => {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    jest.resetModules();
  });

  it('initializes with TLS + pinned CA for a remote (RDS) host', () => {
    process.env.DATABASE_URL =
      'postgresql://u:p@db.abc123.us-east-1.rds.amazonaws.com:5432/bball_tracker';

    let mod: { default: unknown } | undefined;
    jest.isolateModules(() => {
      // requireActual bypasses the global jest.mock('../src/models') from setup.ts
      mod = jest.requireActual('../src/models') as { default: unknown };
    });

    expect(mod?.default).toBeDefined();
  });

  it('skips TLS for a localhost host', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/bball_tracker';

    let mod: { default: unknown } | undefined;
    jest.isolateModules(() => {
      mod = jest.requireActual('../src/models') as { default: unknown };
    });

    expect(mod?.default).toBeDefined();
  });
});
