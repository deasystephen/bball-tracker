/**
 * Pending upload promotion at every write site that stores a
 * `profilePictureUrl` (#1005), through the real route, validation, service
 * and `upload-service`, with Prisma mocked and S3 replaced by the shared double.
 *
 * Every upload is born tagged `pending=true`; the write removes the tag
 * (DeleteObjectTagging) BEFORE the row is written, answers 400
 * `upload_expired` and writes nothing when the object is gone, and skips
 * external URLs. PATCH /auth/me is covered in `auth-profile.test.ts`.
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

const ADMIN_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const PLAYER_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEAM_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const BUCKET = 'bball-tracker-avatars-dev';
const KEY = `avatars/${ADMIN_ID}/0b9f6f1e-2c4e-4c51-9d0a-1f3c5e7a9b2d.jpg`;
const UPLOAD_URL = `https://${BUCKET}.s3.amazonaws.com/${KEY}`;
const EXTERNAL_URL = 'https://workos.example/photo.jpg';
const AUTH = { Authorization: 'Bearer token' };
const EXPIRED_BODY = { error: 'That photo upload expired. Please choose it again.', code: 'upload_expired' };

const taggedKeys = (): unknown[] => sentOfKind(mockS3Send, 'DeleteObjectTagging').map((c) => c.input.Key);
const deletedKeys = (): unknown[] => sentOfKind(mockS3Send, 'DeleteObject').map((c) => c.input.Key);
const prismaError = (code: string): Error =>
  new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });
const expireUpload = (): void => {
  mockS3Send.mockRejectedValueOnce(s3Error('NoSuchKey', 404, 'The specified key does not exist.'));
};
/** True when the S3 promotion happened before `write` was first called. */
const promotedBefore = (write: jest.Mock): boolean =>
  mockS3Send.mock.invocationCallOrder[0] < write.mock.invocationCallOrder[0];

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

  it('promotes the upload before the player row is created', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    expect(taggedKeys()).toEqual([KEY]);
    expect(promotedBefore(mockPrisma.user.create as jest.Mock)).toBe(true);
  });

  it('answers 400 upload_expired and creates nothing when the upload is gone', async () => {
    expireUpload();
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED_BODY);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('discards the promoted upload when the create fails (P2002), so no untagged orphan survives', async () => {
    (mockPrisma.user.create as jest.Mock).mockRejectedValue(prismaError('P2002'));
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(409);
    expect(taggedKeys()).toEqual([KEY]);
    expect(deletedKeys()).toEqual([KEY]);
  });

  it('skips promotion for an external URL', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set(AUTH)
      .send({ name: 'Kid', email: 'kid@example.test', profilePictureUrl: EXTERNAL_URL });

    expect(res.status).toBe(201);
    expect(taggedKeys()).toHaveLength(0);
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

  it('promotes a new upload before the row is updated', async () => {
    arm(null);
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(200);
    expect(taggedKeys()).toEqual([KEY]);
    expect(promotedBefore(mockPrisma.user.update as jest.Mock)).toBe(true);
  });

  it('answers 400 upload_expired and updates nothing when the upload is gone', async () => {
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

  it('discards the promoted upload when the update hits a tombstone (P2025 → 404)', async () => {
    arm(null);
    (mockPrisma.user.update as jest.Mock).mockRejectedValue(prismaError('P2025'));
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set(AUTH)
      .send({ profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(404);
    expect(taggedKeys()).toEqual([KEY]);
    expect(deletedKeys()).toEqual([KEY]);
  });

  it('skips promotion for an external URL and for the URL already stored', async () => {
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
    expect(taggedKeys()).toHaveLength(0);
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

  it('case 1: promotes the upload before the managed player is created', async () => {
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(201);
    expect(taggedKeys()).toEqual([KEY]);
    expect(promotedBefore(mockPrisma.user.create as jest.Mock)).toBe(true);
  });

  it('case 1: answers 400 upload_expired and writes nothing when the upload is gone', async () => {
    expireUpload();
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(EXPIRED_BODY);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
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

  it('case 1: discards the promoted upload when the transaction fails', async () => {
    (mockPrisma.$transaction as jest.Mock).mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(500);
    expect(taggedKeys()).toEqual([KEY]);
    expect(deletedKeys()).toEqual([KEY]);
  });

  it('answers 5xx and writes nothing when S3 denies the promotion (no fail-open)', async () => {
    mockS3Send.mockRejectedValueOnce(s3Error('AccessDenied', 403));
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: UPLOAD_URL });

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(deletedKeys()).toHaveLength(0);
  });

  it('skips promotion for an external URL', async () => {
    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .set(AUTH)
      .send({ name: 'Kid', profilePictureUrl: EXTERNAL_URL });

    expect(res.status).toBe(201);
    expect(taggedKeys()).toHaveLength(0);
  });
});
