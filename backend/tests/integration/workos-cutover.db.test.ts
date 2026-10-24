/**
 * The WorkOS Staging → Production key cutover (#24) and case-insensitive
 * sign-in matching (#955) against a REAL Postgres.
 *
 * - `WorkOSService.syncUser` relinks a row whose `workosUserId` the current
 *   WorkOS environment does not know (the WorkOS SDK is the shared mock from
 *   `tests/setup.ts`; Prisma is real). The relink is a compare-and-set on the
 *   stale id, guarded by `deletedAt IS NULL`, and must keep the row's id,
 *   role, name and memberships.
 * - The email lookup goes through `emailEquals`, so a WorkOS address in a
 *   different case finds the stored row instead of creating a second account,
 *   and two live rows that differ only by case are refused.
 * - `scripts/workos-cutover-check.mjs` (read-only) reports those case
 *   collisions and, with `--check-workos`, which linked rows the WorkOS
 *   environment does not know. It runs as a child process against this
 *   database and a local stand-in for the WorkOS API.
 *
 * CI provides Postgres and runs `prisma migrate deploy`; locally it uses
 * whatever DATABASE_URL points at (docker-compose). Every row is namespaced by
 * a per-run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import prisma from '../../src/models';
import { WorkOSService } from '../../src/services/workos-service';
import { emailEquals } from '../../src/utils/email-match';
import { ConflictError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { removeTestRows } from '../support/test-leftovers';
import { mockWorkOSClient } from '../support/workos-mock';

jest.setTimeout(30000);

const RUN = randomUUID().slice(0, 8);
const userIds: string[] = [];
const BACKEND = path.resolve(__dirname, '../..');
const SCRIPT = path.join(BACKEND, 'scripts/workos-cutover-check.mjs');
const run = promisify(execFile);

/** `<local>.<run>@example.test` — the run id keeps reruns and parallel CI apart. */
function address(local: string): string {
  return `${local}.${RUN}@example.test`;
}

/** A staging-era WorkOS id: production WorkOS answers 404 for it. */
function stagingId(key: string): string {
  return `workos-staging-${key}-${RUN}`;
}

async function mkUser(key: string, data: Record<string, unknown> = {}): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${key}-${RUN}`, email: address(key), role: 'PLAYER', ...data },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

const notFound = (): Error => Object.assign(new Error('Not Found'), { status: 404 });

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      'This suite needs a real Postgres. Start one and apply migrations:\n' +
        '  docker-compose up -d && cd backend && npx prisma migrate deploy\n' +
        `DATABASE_URL=${process.env.DATABASE_URL ?? '(unset)'}`,
      { cause: err }
    );
  }
});

beforeAll(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  mockWorkOSClient.userManagement.getUser.mockReset();
});

afterAll(async () => {
  // By run id, not only by the ids collected along the way (#584).
  await removeTestRows(prisma, { run: RUN, alsoUserIds: userIds });
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

describe('syncUser relink after the key switch (#24)', () => {
  it('moves a staging-linked row to the production identity and keeps everything else', async () => {
    const id = await mkUser('relink', { role: 'COACH', workosUserId: stagingId('relink'), emailVerified: true });
    mockWorkOSClient.userManagement.getUser.mockRejectedValueOnce(notFound());

    const result = await WorkOSService.syncUser({
      id: `workos-prod-relink-${RUN}`,
      // WorkOS may hand the address back in another case (#955).
      email: address('relink').toUpperCase(),
      emailVerified: true,
    });

    expect(result).toMatchObject({ claimedInvite: false, wasManaged: false });
    expect(result.user.id).toBe(id);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      workosUserId: `workos-prod-relink-${RUN}`,
      role: 'COACH',
      name: `relink-${RUN}`,
      email: address('relink'),
    });
    // Same account, not a second one.
    expect(await prisma.user.count({ where: { email: emailEquals(address('relink')) } })).toBe(1);
    // A second sign-in is an ordinary linked sign-in: no WorkOS lookup.
    await WorkOSService.syncUser({ id: `workos-prod-relink-${RUN}`, email: address('relink'), emailVerified: true });
    expect(mockWorkOSClient.userManagement.getUser).toHaveBeenCalledTimes(1);
  });

  it('leaves the row alone and answers 409 when the old identity still exists', async () => {
    const id = await mkUser('known', { workosUserId: stagingId('known') });
    mockWorkOSClient.userManagement.getUser.mockResolvedValueOnce({ id: stagingId('known') });

    await expect(
      WorkOSService.syncUser({ id: `workos-prod-known-${RUN}`, email: address('known'), emailVerified: true })
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).workosUserId).toBe(stagingId('known'));
  });

  it('never relinks a tombstone', async () => {
    const id = await mkUser('tomb', { workosUserId: stagingId('tomb') });
    await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), email: null } });

    const result = await WorkOSService.syncUser({
      id: `workos-prod-tomb-${RUN}`,
      email: address('tomb'),
      emailVerified: true,
    });
    userIds.push(result.user.id);

    // A fresh account, exactly what a post-deletion sign-in gets.
    expect(result.user.id).not.toBe(id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).workosUserId).toBe(stagingId('tomb'));
  });
});

describe('case-insensitive email matching (#955)', () => {
  it('claims a lower-case pre-provisioned row for a mixed-case WorkOS email', async () => {
    const id = await mkUser('kid', { isManaged: true });

    const result = await WorkOSService.syncUser({
      id: `workos-prod-kid-${RUN}`,
      email: `Kid.${RUN}@Example.TEST`,
      emailVerified: true,
    });

    expect(result).toMatchObject({ claimedInvite: true, wasManaged: true });
    expect(result.user.id).toBe(id);
    expect(result.user.email).toBe(address('kid'));
  });

  it('claims a legacy mixed-case row for a lower-case WorkOS email', async () => {
    const id = await mkUser('legacy', { email: `Legacy.${RUN}@example.test` });

    const result = await WorkOSService.syncUser({
      id: `workos-prod-legacy-${RUN}`,
      email: address('legacy'),
      emailVerified: true,
    });

    expect(result.user.id).toBe(id);
  });

  it('stores a new account under the lower-cased address', async () => {
    const result = await WorkOSService.syncUser({
      id: `workos-prod-fresh-${RUN}`,
      email: `  Fresh.${RUN}@Example.TEST `,
      firstName: 'fresh',
      lastName: RUN,
      emailVerified: true,
    });
    userIds.push(result.user.id);

    expect(result.user.email).toBe(address('fresh'));
  });

  it('refuses (409) when two live rows differ only by case, and writes nothing', async () => {
    const lower = await mkUser('dup');
    const upper = await mkUser('dupupper', { email: `Dup.${RUN}@example.test` });

    await expect(
      WorkOSService.syncUser({ id: `workos-prod-dup-${RUN}`, email: address('dup'), emailVerified: true })
    ).rejects.toBeInstanceOf(ConflictError);
    const rows = await prisma.user.findMany({ where: { id: { in: [lower, upper] } }, select: { workosUserId: true } });
    expect(rows.every((row) => row.workosUserId === null)).toBe(true);
  });
});

describe('scripts/workos-cutover-check.mjs (read-only)', () => {
  interface Report {
    users: Record<string, number>;
    caseCollisions: string[][];
    workos?: { environment: string; checked: number; unknownUserIds: string[]; failedUserIds: string[] };
    problems: string[];
  }

  async function check(args: string[], env: Record<string, string> = {}): Promise<{ code: number; report: Report }> {
    try {
      const { stdout } = await run('node', [SCRIPT, ...args], {
        cwd: BACKEND,
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024,
      });
      return { code: 0, report: JSON.parse(stdout) as Report };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      return { code: failed.code ?? -1, report: JSON.parse(failed.stdout ?? '{}') as Report };
    }
  }

  let collisionIds: string[];
  let staleId: string;
  let currentId: string;

  beforeAll(async () => {
    collisionIds = [await mkUser('pair'), await mkUser('pairupper', { email: `PAIR.${RUN}@example.test` })].sort();
    staleId = await mkUser('stale', { workosUserId: stagingId('stale') });
    currentId = await mkUser('current', { workosUserId: `workos-prod-current-${RUN}` });
  });

  it('reports addresses held by more than one live account (exit 2), as user ids only', async () => {
    const { code, report } = await check([]);

    expect(code).toBe(2);
    expect(report.caseCollisions).toContainEqual(collisionIds);
    expect(report.users.linked).toBeGreaterThanOrEqual(2);
    expect(report.users.mixedCaseEmail).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(report)).not.toContain('@example.test');
  });

  it('writes nothing', async () => {
    const before = await prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: 'asc' } });
    await check(['--check-workos', '--no-fail'], { WORKOS_API_KEY: 'sk_test_x', WORKOS_API_URL: 'http://127.0.0.1:9' });
    const after = await prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
  });

  describe('--check-workos', () => {
    let server: Server;
    let url: string;
    const seen: string[] = [];

    beforeAll(async () => {
      // A stand-in for GET /user_management/users/:id in the production
      // environment: it has never heard of a staging-era id.
      server = createServer((req, res) => {
        seen.push(req.headers.authorization ?? '');
        const id = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
        if (id.startsWith('workos-staging-')) {
          res.writeHead(404).end('{}');
        } else if (id === `workos-prod-current-${RUN}`) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
        } else {
          // Rows other suites created: answer like a known identity.
          res.writeHead(200).end('{}');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('lists the rows the environment does not know, which relink on their next sign-in', async () => {
      const { report } = await check(['--check-workos', '--no-fail'], {
        WORKOS_API_KEY: 'sk_live_test_only',
        WORKOS_API_URL: url,
      });

      expect(report.workos?.environment).toBe('production');
      expect(report.workos?.unknownUserIds).toContain(staleId);
      expect(report.workos?.unknownUserIds).not.toContain(currentId);
      expect(seen).toContain('Bearer sk_live_test_only');
    });

    it('counts a lookup that is neither 200 nor 404 as failed (exit 3 without collisions)', async () => {
      const { report } = await check(['--check-workos', '--no-fail'], {
        WORKOS_API_KEY: 'sk_test_x',
        WORKOS_API_URL: 'http://127.0.0.1:9',
      });

      expect(report.workos?.environment).toBe('staging');
      expect(report.workos?.failedUserIds).toContain(staleId);
      expect(report.problems.some((problem) => problem.includes('WorkOS lookup'))).toBe(true);
    });
  });
});
