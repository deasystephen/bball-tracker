/**
 * API tests for PATCH /api/v1/auth/me (self-service profile edits, audit #10)
 */

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

jest.mock('../../src/services/upload-service', () => ({
  deletePreviousAvatar: jest.fn().mockResolvedValue(undefined),
}));
import { deletePreviousAvatar } from '../../src/services/upload-service';
const mockDeletePreviousAvatar = deletePreviousAvatar as jest.Mock;

const AUTH = { Authorization: 'Bearer token' };

describe('PATCH /api/v1/auth/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentRole = 'COACH';
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/u/old.jpg' });
    (mockPrisma.user.update as jest.Mock).mockImplementation(
      async ({ data }: { data: { name?: string; profilePictureUrl?: string | null } }) => ({
        id: TEST_USER_ID,
        email: 'test@example.com',
        name: data.name ?? 'Test User',
        role: currentRole,
        profilePictureUrl: data.profilePictureUrl === undefined ? null : data.profilePictureUrl,
        createdAt: new Date('2026-01-01'),
      })
    );
  });

  it('requires authentication', async () => {
    const res = await request(app).patch('/api/v1/auth/me').send({ name: 'X' });
    expect(res.status).toBe(401);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'COACH', 'PLAYER', 'PARENT'])('lets a %s set their avatar (regression: PATCH /players/:id 404ed for non-players)', async (role) => {
    currentRole = role;
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set(AUTH)
      .send({ profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/u/photo.jpg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.profilePictureUrl).toBe('https://bucket.s3.amazonaws.com/avatars/u/photo.jpg');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_USER_ID },
        data: { profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/u/photo.jpg' },
      })
    );
  });

  it('deletes the replaced avatar object (best-effort) after the update', async () => {
    await request(app)
      .patch('/api/v1/auth/me')
      .set(AUTH)
      .send({ profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/u/new.jpg' });

    expect(mockDeletePreviousAvatar).toHaveBeenCalledWith(
      'https://bucket.s3.amazonaws.com/avatars/u/old.jpg',
      'https://bucket.s3.amazonaws.com/avatars/u/new.jpg'
    );
  });

  it('does not look up or delete the avatar on a name-only update', async () => {
    await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: 'X' });

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockDeletePreviousAvatar).not.toHaveBeenCalled();
  });

  it('updates the name', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ name: '  New Name  ' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('New Name');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'New Name' } })
    );
  });

  it('clears the avatar with an empty string', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({ profilePictureUrl: '' });

    expect(res.status).toBe(200);
    expect(res.body.user.profilePictureUrl).toBeNull();
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { profilePictureUrl: null } })
    );
  });

  it('only ever updates the caller (no id in the body is honored)', async () => {
    await request(app)
      .patch('/api/v1/auth/me')
      .set(AUTH)
      .send({ name: 'X', id: 'someone-else', email: 'evil@example.com', role: 'ADMIN' });

    const call = (mockPrisma.user.update as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: TEST_USER_ID });
    expect(call.data).toEqual({ name: 'X' });
  });

  it('rejects an empty body', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(AUTH).send({});
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
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
    (mockPrisma.user.update as jest.Mock).mockRejectedValue(new Error('db down'));
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
