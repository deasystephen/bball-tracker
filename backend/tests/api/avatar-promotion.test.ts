/**
 * The pending-upload save order at every write site that stores a
 * `profilePictureUrl` (#1005), through the real route, validation, service
 * and `upload-service`, with Prisma mocked and S3 replaced by the shared double.
 *
 * The order (#1005): HeadObject BEFORE the row is written (400
 * `upload_expired` and nothing written when it is gone), the write, and the
 * untag (DeleteObjectTagging) only AFTER it committed. A failed write makes
 * no S3 call after the check. External URLs make no S3 call at all.
 * PATCH /auth/me is covered in `auth-profile.test.ts`.
 */

const mockS3Send = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () =>
  jest.requireActual('../support/s3-mock').mockS3ClientModule((...args: unknown[]) => mockS3Send(...args))
);

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'ADMIN',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

// Add Player's roster permission; everything else in the route runs for real.
jest.mock('../../src/utils/permissions', () => ({
  ...jest.requireActual('../../src/utils/permissions'),
  hasTeamPermission: jest.fn().mockResolvedValue(true),
}));

import { Prisma } from '@prisma/client';
import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import { s3Error, sentOfKind } from '../support/s3-mock';
import { logger } from '../../src/utils/logger';
import * as sentry from '../../src/utils/sentry';

const ADMIN_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const PLAYER_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEAM_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const BUCKET = 'bball-tracker-avatars-dev';
const KEY = `avatars/${ADMIN_ID}/0b9f6f1e-2c4e-4c51-9d0a-1f3c5e7a9b2d.jpg`;
const UPLOAD_URL = `https://${BUCKET}.s3.amazonaws.com/${KEY}`;
const EXTERNAL_URL = 'https://workos.example/photo.jpg';
const AUTH = { Authorization: 'Bearer token' };
const EXPIRED_BODY = { error: 'That photo upload expired. Please choose it again.', code: 'upload_expired' };

/** `[kind, key]` of every S3 call, in order. */
const s3Calls = (): [string, unknown][] =>
  mockS3Send.mock.calls.map(([cmd]) => {
    const c = cmd as { kind: string; input: Record<string, unknown> };
    return [c.kind, c.input.Key];
  });
const deletedKeys = (): unknown[] => sentOfKind(mockS3Send, 'DeleteObject').map((c) => c.input.Key);
const prismaError = (code: string): Error =>
  new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });
const expireUpload = (): void => {
  mockS3Send.mockRejectedValueOnce(s3Error('NotFound', 404, 'Not Found'));
};
/** HEAD before the write, untag after it: the order #1005 relies on. */
const checkedThenUntagged = (write: jest.Mock): void => {
  expect(s3Calls()).toEqual([
    ['HeadObject', KEY],
    ['DeleteObjectTagging', KEY],
  ]);
  const writeAt = write.mock.invocationCallOrder[0];
  expect(mockS3Send.mock.invocationCallOrder[0]).toBeLessThan(writeAt);
  expect(mockS3Send.mock.invocationCallOrder[1]).toBeGreaterThan(writeAt);
};

const playerRow = (profilePictureUrl: string | null): Record<string, unknown> => ({
  id: PLAYER_ID,
  email: 'kid@example.test',
  name: 'Kid',
  role: 'PLAYER',
  profilePictureUrl,
  deletedAt: null,
  workosUserId: null,
  isManaged: true,
  managedById: null,
  emailVerified: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
});

beforeEach(() => {
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({});
  // The pre-write check only runs with pending tagging on; most cases test that mode.
  process.env.AVATAR_PENDING_TAG_ENABLED = 'true';
});

afterAll(() => {
  delete process.env.AVATAR_PENDING_TAG_ENABLED;
});

afterAll((done) => {
  httpServer.close(() => done());
});

describe('POST /api/v1/players', () => {
  beforeEach(() => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.user.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...playerRow(null),
      ...data,
    }));
  });

  it('checks the upload before the create and untags it after', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    checkedThenUntagged(mockPrisma.user.create as jest.Mock);
  });

  it('answers 400 upload_expired and creates nothing when HeadObject says 404', async () => {
    expireUpload();
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED_BODY);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    // The HEAD 404 is told apart from a missing bucket by one HeadBucket
    expect(s3Calls()).toEqual([
      ['HeadObject', KEY],
      ['HeadBucket', undefined],
    ]);
  });

  it('a failed create (P2002) makes no S3 call after the check', async () => {
    (mockPrisma.user.create as jest.Mock).mockRejectedValue(prismaError('P2002'));
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(409);
    expect(s3Calls()).toEqual([['HeadObject', KEY]]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('an untag that fails after the commit is one call, reported to Sentry, and the response is still 201', async () => {
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockS3Send.mockImplementation(async (cmd: { kind: string }) => {
      if (cmd.kind === 'DeleteObjectTagging') throw s3Error('InternalError', 500);
      return {};
    });

    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    expect(s3Calls()).toEqual([
      ['HeadObject', KEY],
      ['DeleteObjectTagging', KEY],
    ]);
    expect(captureSpy).toHaveBeenCalledWith(expect.anything(), { flow: 'avatar-promote' });
    captureSpy.mockRestore();
  });

  it('makes no S3 call for an external URL', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: EXTERNAL_URL });

    expect(res.status).toBe(201);
    expect(s3Calls()).toHaveLength(0);
  });
  it('a HEAD 404 with the bucket missing is a 5xx, not upload_expired, and creates nothing', async () => {
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockS3Send
      .mockRejectedValueOnce(s3Error('NotFound', 404, 'Not Found'))
      .mockRejectedValueOnce(s3Error('NotFound', 404, 'Not Found'));

    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    // One report per failure: the route's handler, not checkAvatarUpload
    expect(captureSpy).not.toHaveBeenCalledWith(expect.anything(), { flow: 'avatar-promote' });
    captureSpy.mockRestore();
  });
});

describe('PATCH /api/v1/players/:id', () => {
  function arm(stored: string | null): void {
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === PLAYER_ID ? playerRow(stored) : { id: ADMIN_ID, role: 'ADMIN', deletedAt: null }
    );
    (mockPrisma.user.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...playerRow(stored),
      ...data,
    }));
  }

  it('checks a new upload before the update and untags it after', async () => {
    arm(null);
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(200);
    checkedThenUntagged(mockPrisma.user.update as jest.Mock);
  });

  it('answers 400 upload_expired and updates nothing when HeadObject says 404', async () => {
    arm(null);
    expireUpload();
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED_BODY);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('a failed update (P2025, a tombstone) makes no S3 call after the check', async () => {
    arm(null);
    (mockPrisma.user.update as jest.Mock).mockRejectedValue(prismaError('P2025'));
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(404);
    expect(s3Calls()).toEqual([['HeadObject', KEY]]);
  });

  it('makes no S3 call for an external URL or for the URL already stored', async () => {
    arm(UPLOAD_URL);
    const external = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: EXTERNAL_URL });
    const same = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: UPLOAD_URL });

    expect(external.status).toBe(200);
    expect(same.status).toBe(200);
    // (Replacing the stored photo with the external one deletes the old object, as before #1005)
    expect(s3Calls().filter(([kind]) => kind !== 'DeleteObject')).toHaveLength(0);
  });
});

describe('POST /api/v1/teams/:teamId/players (Add Player)', () => {
  beforeEach(() => {
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ id: TEAM_ID });
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValue({ id: PLAYER_ID });
    (mockPrisma.teamMember.create as jest.Mock).mockResolvedValue({
      teamId: TEAM_ID,
      playerId: PLAYER_ID,
      jerseyNumber: null,
      position: null,
      player: { id: PLAYER_ID, name: 'Kid', email: null, isManaged: true, managedById: ADMIN_ID },
      team: { id: TEAM_ID, name: 'Team' },
    });
  });

  it('case 1: checks the upload before the managed player is created and untags it after', async () => {
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    checkedThenUntagged(mockPrisma.teamMember.create as jest.Mock);
  });

  it('case 1: answers 400 upload_expired and writes nothing when HeadObject says 404', async () => {
    expireUpload();
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED_BODY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('case 2: answers 400 upload_expired before any row or invitation is written', async () => {
    expireUpload();
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', playerEmail: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED_BODY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('case 1: a failed transaction makes no S3 call after the check', async () => {
    (mockPrisma.$transaction as jest.Mock).mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(500);
    expect(s3Calls()).toEqual([['HeadObject', KEY]]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('case 2: a retry after a commit (the reused row already stores this URL) makes no S3 call', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: PLAYER_ID,
      email: 'kid@example.test',
      workosUserId: null,
      managedById: ADMIN_ID,
      profilePictureUrl: UPLOAD_URL,
      deletedAt: null,
    });
    (mockPrisma.$transaction as jest.Mock).mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', playerEmail: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(500);
    expect(s3Calls()).toHaveLength(0);
  });

  it('with the flag off, the save makes no check (no expiry exists) and still untags after the write', async () => {
    delete process.env.AVATAR_PENDING_TAG_ENABLED;
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    expect(s3Calls()).toEqual([['DeleteObjectTagging', KEY]]);
  });

  it('with the flag off, an untag denied after the write is reported and the response is still 201', async () => {
    delete process.env.AVATAR_PENDING_TAG_ENABLED;
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockS3Send.mockRejectedValueOnce(s3Error('AccessDenied', 403));
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    expect(captureSpy).toHaveBeenCalledWith(expect.anything(), { flow: 'avatar-promote' });
    captureSpy.mockRestore();
  });

  it('with the flag on, AccessDenied on the check is a 5xx and nothing is written', async () => {
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    mockS3Send.mockRejectedValueOnce(s3Error('AccessDenied', 403));
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalledWith(expect.anything(), { flow: 'avatar-promote' });
    captureSpy.mockRestore();
  });

  it('makes no S3 call for an external URL', async () => {
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: EXTERNAL_URL });

    expect(res.status).toBe(201);
    expect(s3Calls()).toHaveLength(0);
  });
});
