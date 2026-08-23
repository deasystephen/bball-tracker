/**
 * API tests for PATCH /api/v1/auth/me/role (self-select account type)
 */

import request from 'supertest';
import { app } from '../../src/index';
import { mockPrisma } from '../setup';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
let currentRole = 'PLAYER';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
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

describe('PATCH /api/v1/auth/me/role', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentRole = 'PLAYER';
    (mockPrisma.user.update as jest.Mock).mockImplementation(async ({ data }: { data: { role: string } }) => ({
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: data.role,
      createdAt: new Date('2026-01-01'),
    }));
  });

  it('lets a PLAYER become a COACH', async () => {
    const res = await request(app).patch('/api/v1/auth/me/role').send({ role: 'COACH' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.role).toBe('COACH');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEST_USER_ID }, data: { role: 'COACH' } })
    );
  });

  it('lets a COACH switch back to PLAYER', async () => {
    currentRole = 'COACH';
    const res = await request(app).patch('/api/v1/auth/me/role').send({ role: 'PLAYER' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('PLAYER');
  });

  it('is idempotent when re-selecting the current role', async () => {
    const res = await request(app).patch('/api/v1/auth/me/role').send({ role: 'PLAYER' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('PLAYER');
  });

  it.each(['ADMIN', 'PARENT'])('returns 403 for a %s account', async (role) => {
    currentRole = role;
    const res = await request(app).patch('/api/v1/auth/me/role').send({ role: 'COACH' });

    expect(res.status).toBe(403);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('never lets a user escalate to ADMIN', async () => {
    const res = await request(app).patch('/api/v1/auth/me/role').send({ role: 'ADMIN' });

    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing or malformed role', async () => {
    expect((await request(app).patch('/api/v1/auth/me/role').send({})).status).toBe(400);
    expect((await request(app).patch('/api/v1/auth/me/role').send({ role: 'coach' })).status).toBe(400);
  });

  it('returns 500 (not a leaked stack) when the database fails', async () => {
    (mockPrisma.user.update as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await request(app).patch('/api/v1/auth/me/role').send({ role: 'COACH' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to update role' });
  });
});
