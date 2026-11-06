/**
 * Unreferenced avatar uploads against a REAL Postgres (#957).
 *
 * The reference set that protects in-use photos is a query over every
 * `User.profilePictureUrl`; a miss deletes a photo that is on someone's row
 * (the bucket is unversioned). These cases prove, through the real account
 * deletion path, that a coach's upload written onto a managed player's row
 * survives the coach's deletion while the coach's abandoned upload goes. S3 is
 * stubbed; Prisma is real.
 *
 * Every row is namespaced by a per-run id and removed in afterAll.
 */
jest.unmock('../../src/models');

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () =>
  jest.requireActual('../support/s3-mock').mockS3ClientModule((...args: unknown[]) => mockS3Send(...args))
);

import { randomUUID } from 'node:crypto';
import { removeTestRows } from '../support/test-leftovers';
import { sentOfKind, type SentS3Command } from '../support/s3-mock';
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import { loadReferencedAvatarKeys } from '../../src/services/upload-service';
import { logger } from '../../src/utils/logger';
import { spyOnInfo } from '../support/domain-events';

jest.setTimeout(30000);

const RUN = randomUUID().slice(0, 8);
const userIds: string[] = [];
const BUCKET = process.env.S3_AVATARS_BUCKET || 'bball-tracker-avatars-dev';
const urlOf = (key: string): string => `https://${BUCKET}.s3.amazonaws.com/${key}`;

async function mkUser(local: string, extra: Record<string, unknown> = {}): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${local}-${RUN}`, email: `${local}.${RUN}@example.test`, role: 'PLAYER', ...extra },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

type Sent = SentS3Command;
const sentOf = (kind: string): Sent[] => sentOfKind(mockS3Send, kind);

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
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  spyOnInfo();
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({});
});

afterAll(async () => {
  await removeTestRows(prisma, { run: RUN, alsoUserIds: userIds });
  await prisma.$disconnect();
});

describe('avatar cleanup (real Postgres, #957)', () => {
  it('loadReferencedAvatarKeys(userId) finds every row naming the id, however the URL is spelled', async () => {
    const a = await mkUser('ref-a');
    // Canonical, regional host, and a percent-encoded `avatars/` segment, each on a different row
    await prisma.user.update({ where: { id: a }, data: { profilePictureUrl: urlOf(`avatars/${a}/one.jpg`) } });
    await mkUser('ref-b', { profilePictureUrl: `https://${BUCKET}.s3.us-east-1.amazonaws.com/avatars/${a}/two.jpg` });
    await mkUser('ref-c', { profilePictureUrl: `https://${BUCKET}.s3.amazonaws.com/%61vatars/${a}/three.jpg` });
    // Another user's photo is not loaded
    const other = await mkUser('ref-d');
    await prisma.user.update({ where: { id: other }, data: { profilePictureUrl: urlOf(`avatars/${other}/x.jpg`) } });

    const keys = await loadReferencedAvatarKeys(a);

    expect(keys.has(`avatars/${a}/one.jpg`)).toBe(true);
    expect(keys.has(`avatars/${a}/two.jpg`)).toBe(true);
    expect(keys.has(`avatars/${a}/three.jpg`)).toBe(true);
    expect(keys.has(`avatars/${other}/x.jpg`)).toBe(false);
  });

  it("deleting a coach removes the coach's orphaned upload and keeps the photo on a managed player's row", async () => {
    const coach = await mkUser('coach', { role: 'COACH' });
    const inUse = `avatars/${coach}/kid.jpg`;
    const orphan = `avatars/${coach}/abandoned.jpg`;
    const own = `avatars/${coach}/me.jpg`;
    await prisma.user.update({ where: { id: coach }, data: { profilePictureUrl: urlOf(own) } });
    await mkUser('kid', { isManaged: true, managedById: coach, profilePictureUrl: urlOf(inUse) });

    mockS3Send.mockImplementation(async (cmd: Sent) =>
      cmd.kind === 'ListObjectsV2'
        ? {
            Contents: [inUse, orphan, own].map((Key) => ({ Key })),
            IsTruncated: false,
          }
        : {}
    );

    await AccountService.deleteAccount(coach, { actorId: coach, mode: 'self' });

    // The current photo goes through deletePreviousAvatar as before.
    expect(sentOf('DeleteObject').map((c) => c.input.Key)).toEqual([own]);
    expect(sentOf('ListObjectsV2')[0].input).toEqual(expect.objectContaining({ Prefix: `avatars/${coach}/` }));
    const batches = sentOf('DeleteObjects');
    expect(batches).toHaveLength(1);
    const deleted = (batches[0].input.Delete as { Objects: { Key: string }[] }).Objects.map((o) => o.Key);
    // The coach's row no longer references `own` (nulled in the transaction), so
    // it is listed as unreferenced too; deleting it twice is harmless.
    expect(deleted.sort()).toEqual([orphan, own].sort());
    expect(deleted).not.toContain(inUse);
  });
});
