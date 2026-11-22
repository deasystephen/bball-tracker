/**
 * API test for DELETE /api/v1/players/:id with the real PlayerService (#725).
 *
 * `tests/api/players.test.ts` mocks PlayerService wholesale. Here the request
 * runs validation -> route -> PlayerService.deletePlayer -> (mocked) Prisma ->
 * the real `deletePreviousAvatar` -> (mocked) S3 client, the same path as
 * production. Only Prisma and `@aws-sdk/client-s3` are doubles.
 */

import type { DeleteObjectCommandInput } from '@aws-sdk/client-s3';

const deleteObjectCalls: DeleteObjectCommandInput[] = [];
const mockS3Send = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: DeleteObjectCommandInput) => {
    deleteObjectCalls.push(input);
    return { input };
  }),
  DeleteObjectTaggingCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'DeleteObjectTagging', input })),
  HeadObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'HeadObject', input })),
  HeadBucketCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'HeadBucket', input })),
}));

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'ADMIN',
    };
    next();
  }),
}));

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import { USER_REFERENCE_COUNT_SELECT } from '../../src/services/account-service';

const ADMIN_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const PLAYER_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const BUCKET = process.env.S3_AVATARS_BUCKET || 'bball-tracker-avatars-dev';
const AVATAR_KEY = 'avatars/c3d4e5f6-a7b8-4012-a456-7890abcdef01/0b9f6f1e-2c4e-4c51-9d0a-1f3c5e7a9b2d.jpg';
const AVATAR_URL = `https://${BUCKET}.s3.amazonaws.com/${AVATAR_KEY}`;

/** Reference counts for the delete transaction's read (#1047): zero unless overridden. */
function refs(counts: Record<string, number> = {}): { _count: Record<string, number>; personalLeague: null } {
  return {
    _count: { ...Object.fromEntries(Object.keys(USER_REFERENCE_COUNT_SELECT).map((key) => [key, 0])), ...counts },
    personalLeague: null,
  };
}

/**
 * The admin caller, then an un-rostered, event-less player holding
 * `profilePictureUrl`, then the delete transaction's locked row and its
 * reference counts (`counts`, all zero by default).
 */
function mockDeletablePlayer(profilePictureUrl: string | null, counts: Record<string, number> = {}): void {
  (mockPrisma.user.findUnique as jest.Mock)
    .mockResolvedValueOnce({ id: ADMIN_ID, role: 'ADMIN', deletedAt: null })
    .mockResolvedValueOnce({
      id: PLAYER_ID,
      role: 'PLAYER',
      deletedAt: null,
      workosUserId: null,
      profilePictureUrl,
      teamMembers: [],
      gameEvents: [],
    })
    .mockResolvedValueOnce(refs(counts));
  (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ workosUserId: null, deletedAt: null }]);
  // A refused delete never reaches the write; queueing it would leak into the next test.
  if (Object.keys(counts).length === 0) {
    (mockPrisma.user.delete as jest.Mock).mockResolvedValueOnce({ profilePictureUrl });
  }
}

describe('DELETE /api/v1/players/:id through the real PlayerService (#725)', () => {
  beforeEach(() => {
    deleteObjectCalls.length = 0;
  });

  it('deletes the row, then the bucket avatar object it referenced', async () => {
    mockDeletablePlayer(AVATAR_URL);

    const response = await request(app).delete(`/api/v1/players/${PLAYER_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: 'Player deleted successfully' });
    expect(mockPrisma.user.delete).toHaveBeenCalledWith({
      where: { id: PLAYER_ID, deletedAt: null },
      select: { profilePictureUrl: true },
    });
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(deleteObjectCalls).toEqual([{ Bucket: BUCKET, Key: AVATAR_KEY }]);
  });

  it('answers 200 and makes no S3 call for a player with no avatar', async () => {
    mockDeletablePlayer(null);

    const response = await request(app).delete(`/api/v1/players/${PLAYER_ID}`);

    expect(response.status).toBe(200);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(deleteObjectCalls).toEqual([]);
  });
});

describe('DELETE /api/v1/players/:id on a claimed account (#1034)', () => {
  beforeEach(() => {
    deleteObjectCalls.length = 0;
  });

  it('answers an ADMIN 403 claimed_account and deletes nothing, S3 included', async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: ADMIN_ID, role: 'ADMIN', deletedAt: null })
      .mockResolvedValueOnce({
        id: PLAYER_ID,
        role: 'PLAYER',
        deletedAt: null,
        workosUserId: 'user_01CLAIMED',
        profilePictureUrl: AVATAR_URL,
        teamMembers: [],
        gameEvents: [],
      });

    const response = await request(app).delete(`/api/v1/players/${PLAYER_ID}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('claimed_account');
    expect(response.body.error).toContain('DELETE /auth/me');
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('answers 403 claimed_account when the row is claimed after the read (the locked row has a login)', async () => {
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: ADMIN_ID, role: 'ADMIN', deletedAt: null })
      .mockResolvedValueOnce({
        id: PLAYER_ID,
        role: 'PLAYER',
        deletedAt: null,
        workosUserId: null,
        profilePictureUrl: null,
        teamMembers: [],
        gameEvents: [],
      });
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ deletedAt: null, workosUserId: 'user_01RACE' }]);

    const response = await request(app).delete(`/api/v1/players/${PLAYER_ID}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('claimed_account');
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/players/:id on a record something references (#1047)', () => {
  beforeEach(() => {
    deleteObjectCalls.length = 0;
  });

  it('answers 409 player_has_records naming the relations, and deletes nothing, S3 included', async () => {
    mockDeletablePlayer(AVATAR_URL, { guardiansAsChild: 1, gameRsvps: 3 });

    const response = await request(app).delete(`/api/v1/players/${PLAYER_ID}`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: expect.stringContaining('guardian'),
      code: 'player_has_records',
      relations: ['guardiansAsChild', 'gameRsvps'],
    });
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
