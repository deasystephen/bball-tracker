/**
 * API tests for PATCH /api/v1/auth/me (self-service profile edits, audit #10)
 */

// The real upload-service with only the S3 client mocked (#717): the
// ownership gate and the delete run for real, and the assertions below are on
// the DeleteObjectCommand keys that would have reached S3.
import type { DeleteObjectCommandInput } from '@aws-sdk/client-s3';
const deleteObjectCalls: DeleteObjectCommandInput[] = [];
const mockS3Send = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: DeleteObjectCommandInput) => {
    deleteObjectCalls.push(input);
    return { input };
  }),
}));

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
let currentRole = 'COACH';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    req.user = {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: currentRole,
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

const AUTH = { Authorization: 'Bearer token' };

/** The bucket upload-service addresses in tests (S3_AVATARS_BUCKET unset). */
const BUCKET_BASE = 'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/';
const OWN_OLD = `${BUCKET_BASE}${TEST_USER_ID}/old.jpg`;
const OWN_NEW = `${BUCKET_BASE}${TEST_USER_ID}/new.jpg`;
const VICTIM_ID = 'ffffffff-0000-4000-8000-000000000001';
const VICTIM_URL = `${BUCKET_BASE}${VICTIM_ID}/photo.jpg`;

describe('PATCH /api/v1/auth/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deleteObjectCalls.length = 0;
    currentRole = 'COACH';
    // The stored avatar is the caller's own previous upload; the second read
    // (after a write) returns what the write stored, like the real row would.
    let written: { name?: string; profilePictureUrl?: string | null; notifyOnReplies?: boolean } = {};
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation(async () => ({
      profilePictureUrl: written.profilePictureUrl === undefined ? OWN_OLD : written.profilePictureUrl,
    }));
    // The write is a guarded updateMany (`deletedAt: null`, #444 D9) followed
    // by a re-read; the mock re-read reflects whatever the write carried.
    (mockPrisma.user.updateMany as jest.Mock).mockImplementation(async ({ data }: { data: typeof written }) => {
      written = data;
      return { count: 1 };
    });
    (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockImplementation(async () => ({
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: written.name ?? 'Test User',
      role: currentRole,
      profilePictureUrl: written.profilePictureUrl === undefined ? null : written.profilePictureUrl,
      notifyOnReplies: written.notifyOnReplies ?? true,
      createdAt: new Date('2026-01-01'),
    }));
  });

  it('answers 401 and writes nothing visible when the account was deleted underneath the request (#444 D9)', async () => {
    (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: 'Back From The Dead' });

    expect(res.status).toBe(401);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEST_USER_ID, deletedAt: null } })
    );
    expect(mockPrisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await request(app).patch('/api/v1/auth/me').send({ name: 'X' });
    expect(res.status).toBe(401);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'COACH', 'PLAYER', 'PARENT'])('lets a %s set their avatar (regression: PATCH /players/:id 404ed for non-players)', async (role) => {
    currentRole = role;
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set(AUTH)
      .send({ profilePictureUrl: OWN_NEW });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.profilePictureUrl).toBe(OWN_NEW);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_USER_ID, deletedAt: null },
        data: { profilePictureUrl: OWN_NEW },
      })
    );
  });

  it('deletes the replaced avatar object (best-effort) after the update', async () => {
    await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: OWN_NEW });

    expect(deleteObjectCalls).toEqual([
      { Bucket: 'bball-tracker-avatars-dev', Key: `avatars/${TEST_USER_ID}/old.jpg` },
    ]);
  });

  it('does not look up or delete the avatar on a name-only update', async () => {
    await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: 'X' });

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(deleteObjectCalls).toHaveLength(0);
  });

  describe('a managed-bucket URL must be the caller\'s own upload (#717)', () => {
    it('accepts an external https URL (a WorkOS profile photo) as before', async () => {
      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set(AUTH)
        .send({ profilePictureUrl: 'https://workos.example/photo.jpg' });

      expect(res.status).toBe(200);
      expect(res.body.user.profilePictureUrl).toBe('https://workos.example/photo.jpg');
    });

    it.each([
      ['another user\'s avatar URL', VICTIM_URL],
      ['a ../ hop from the own prefix into another user\'s', `${BUCKET_BASE}${TEST_USER_ID}/../${VICTIM_ID}/photo.jpg`],
      ['an encoded ../ hop', `${BUCKET_BASE}${TEST_USER_ID}/%2e%2e/${VICTIM_ID}/photo.jpg`],
      ['a ../ hop out of avatars/', `${BUCKET_BASE}${TEST_USER_ID}/../../any-key.jpg`],
    ])('answers 400 and writes nothing for %s', async (_label, url) => {
      const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: url });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('profilePictureUrl must be an upload issued to the caller');
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('the store-then-clear sequence never deletes the other user\'s object', async () => {
      // Step 1 of the attack: point the caller's row at the victim's URL.
      const store = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: VICTIM_URL });
      expect(store.status).toBe(400);

      // Step 2: clear the avatar, which deletes whatever the row holds. The row
      // still holds the caller's own previous upload, so that is all that goes.
      const clear = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: '' });
      expect(clear.status).toBe(200);

      const keys = deleteObjectCalls.map((call) => call.Key);
      expect(keys).toEqual([`avatars/${TEST_USER_ID}/old.jpg`]);
      expect(keys).not.toContain(`avatars/${VICTIM_ID}/photo.jpg`);
    });

    it('a pre-gate row holding a traversal URL deletes nothing outside avatars/ when cleared', async () => {
      // Defence in depth: the stored value predates the gate (or came from
      // somewhere else) and would collapse to a key outside avatars/.
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        profilePictureUrl: `${BUCKET_BASE}${TEST_USER_ID}/../../any-key.jpg`,
      });

      const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: '' });

      expect(res.status).toBe(200);
      expect(deleteObjectCalls).toHaveLength(0);
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  it('updates the name', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: '  New Name  ' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('New Name');
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'New Name' } })
    );
  });

  it('clears the avatar with an empty string', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: '' });

    expect(res.status).toBe(200);
    expect(res.body.user.profilePictureUrl).toBeNull();
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { profilePictureUrl: null } })
    );
  });

  it('only ever updates the caller (no id in the body is honored)', async () => {
    await request(app)
      .patch('/api/v1/auth/me')
      .set(AUTH)
      .send({ name: 'X', id: 'someone-else', email: 'evil@example.com', role: 'ADMIN' });

    const call = (mockPrisma.user.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: TEST_USER_ID, deletedAt: null });
    expect(call.data).toEqual({ name: 'X' });
  });

  it('turns reply notifications off and on, and returns the stored value (#34)', async () => {
    const off = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ notifyOnReplies: false });

    expect(off.status).toBe(200);
    expect(off.body.user.notifyOnReplies).toBe(false);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEST_USER_ID, deletedAt: null }, data: { notifyOnReplies: false } })
    );
    // A preference change never touches the avatar.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(deleteObjectCalls).toHaveLength(0);

    const on = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ notifyOnReplies: true });
    expect(on.status).toBe(200);
    expect(on.body.user.notifyOnReplies).toBe(true);
  });

  it('rejects a non-boolean notifyOnReplies', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ notifyOnReplies: 'no' });
    expect(res.status).toBe(400);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({});
    expect(res.status).toBe(400);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a javascript: avatar URL', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set(AUTH)
      .send({ profilePictureUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty name', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected errors', async () => {
    (mockPrisma.user.updateMany as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: 'X' });
    expect(res.status).toBe(500);
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
