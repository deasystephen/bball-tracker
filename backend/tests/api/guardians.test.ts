/**
 * Guardians API Integration Tests (PARENT role — docs/plans/parent-role-spec.md)
 *
 * /api/v1/teams/:teamId/members/:playerId/guardians
 */

import request from 'supertest';
import { app } from '../../src/index';
import { GuardianService } from '../../src/services/guardian-service';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../src/utils/errors';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEST_PLAYER_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';
const TEST_GUARDIAN_USER_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'coach@example.com',
      name: 'Test Coach',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: unknown, _res: unknown, next: () => void): void => next()),
}));

jest.mock('../../src/services/guardian-service');

const mockGuardianService = GuardianService as jest.Mocked<typeof GuardianService>;

const base = `/api/v1/teams/${TEST_TEAM_ID}/members/${TEST_PLAYER_ID}/guardians`;

const mockInvitation = {
  id: 'c3d4e5f6-a7b8-4012-a456-7890abcdef01',
  childId: TEST_PLAYER_ID,
  teamId: TEST_TEAM_ID,
  invitedEmail: 'parent@example.com',
  relationship: 'MOTHER' as const,
  invitedById: TEST_USER_ID,
  status: 'PENDING' as const,
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  acceptedAt: null,
};

describe('Guardians API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /teams/:teamId/members/:playerId/guardians', () => {
    it('invites a guardian and returns 201 without the token', async () => {
      mockGuardianService.inviteGuardian.mockResolvedValue({
        ...mockInvitation,
        token: 'SECRET',
        emailSent: true,
      } as unknown as Awaited<ReturnType<typeof mockGuardianService.inviteGuardian>>);

      const res = await request(app)
        .post(base)
        .send({ email: 'parent@example.com', relationship: 'MOTHER' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation.invitedEmail).toBe('parent@example.com');
      expect(res.body.invitation).not.toHaveProperty('token');
      // emailSent is a sibling of invitation, not nested inside it (the route
      // destructures it off the service result — unification spec)
      expect(res.body.emailSent).toBe(true);
      expect(res.body.invitation).not.toHaveProperty('emailSent');
      expect(mockGuardianService.inviteGuardian).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        TEST_PLAYER_ID,
        { email: 'parent@example.com', relationship: 'MOTHER' },
        TEST_USER_ID
      );
    });

    it('surfaces a failed guardian email as emailSent: false', async () => {
      mockGuardianService.inviteGuardian.mockResolvedValue({
        ...mockInvitation,
        emailSent: false,
      } as unknown as Awaited<ReturnType<typeof mockGuardianService.inviteGuardian>>);

      const res = await request(app)
        .post(base)
        .send({ email: 'parent@example.com', relationship: 'MOTHER' });

      expect(res.status).toBe(201);
      expect(res.body.emailSent).toBe(false);
    });

    it('returns 400 for an invalid email', async () => {
      const res = await request(app).post(base).send({ email: 'nope', relationship: 'MOTHER' });

      expect(res.status).toBe(400);
      expect(mockGuardianService.inviteGuardian).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown relationship', async () => {
      const res = await request(app).post(base).send({ email: 'parent@example.com', relationship: 'UNCLE' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Relationship');
    });

    it('returns 400 for missing body fields', async () => {
      const res = await request(app).post(base).send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 for a malformed playerId', async () => {
      const res = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/members/not-a-uuid/guardians`)
        .send({ email: 'parent@example.com', relationship: 'MOTHER' });

      expect(res.status).toBe(400);
      expect(mockGuardianService.inviteGuardian).not.toHaveBeenCalled();
    });

    it('returns 403 when the caller cannot manage the roster', async () => {
      mockGuardianService.inviteGuardian.mockRejectedValue(new ForbiddenError('nope'));

      const res = await request(app).post(base).send({ email: 'parent@example.com', relationship: 'FATHER' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('nope');
    });

    it('returns 404 when the player is not on the team', async () => {
      mockGuardianService.inviteGuardian.mockRejectedValue(new NotFoundError('Player is not on this team'));

      const res = await request(app).post(base).send({ email: 'parent@example.com', relationship: 'FATHER' });

      expect(res.status).toBe(404);
    });

    it('returns 400 for a duplicate pending invitation', async () => {
      mockGuardianService.inviteGuardian.mockRejectedValue(
        new BadRequestError('A pending guardian invitation already exists for this email')
      );

      const res = await request(app).post(base).send({ email: 'parent@example.com', relationship: 'FATHER' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already exists');
    });

    it('returns 500 on unexpected errors', async () => {
      mockGuardianService.inviteGuardian.mockRejectedValue(new Error('boom'));

      const res = await request(app).post(base).send({ email: 'parent@example.com', relationship: 'FATHER' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to invite guardian');
    });
  });

  describe('GET /teams/:teamId/members/:playerId/guardians', () => {
    it('lists guardians and pending invitations', async () => {
      mockGuardianService.listGuardians.mockResolvedValue({
        guardians: [
          {
            id: 'g-1',
            userId: TEST_GUARDIAN_USER_ID,
            name: 'Mom',
            email: 'mom@example.com',
            relationship: 'MOTHER',
            isPrimary: true,
            createdAt: new Date(),
          },
        ],
        pendingInvitations: [
          { ...mockInvitation, token: 'SECRET' } as unknown as Awaited<
            ReturnType<typeof mockGuardianService.listGuardians>
          >['pendingInvitations'][number],
        ],
      });

      const res = await request(app).get(base);

      expect(res.status).toBe(200);
      expect(res.body.guardians).toHaveLength(1);
      expect(res.body.guardians[0].userId).toBe(TEST_GUARDIAN_USER_ID);
      expect(res.body.pendingInvitations).toHaveLength(1);
      expect(res.body.pendingInvitations[0]).not.toHaveProperty('token');
      expect(mockGuardianService.listGuardians).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_PLAYER_ID, TEST_USER_ID);
    });

    it('returns 403 for a caller with no access', async () => {
      mockGuardianService.listGuardians.mockRejectedValue(new ForbiddenError('no'));

      const res = await request(app).get(base);

      expect(res.status).toBe(403);
    });

    it('returns 404 when the player is not on the team', async () => {
      mockGuardianService.listGuardians.mockRejectedValue(new NotFoundError('Player is not on this team'));

      const res = await request(app).get(base);

      expect(res.status).toBe(404);
    });

    it('returns 500 on unexpected errors', async () => {
      mockGuardianService.listGuardians.mockRejectedValue(new Error('boom'));

      const res = await request(app).get(base);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to list guardians');
    });
  });

  describe('DELETE /teams/:teamId/members/:playerId/guardians/:guardianUserId', () => {
    it('removes a guardian', async () => {
      mockGuardianService.removeGuardian.mockResolvedValue(undefined);

      const res = await request(app).delete(`${base}/${TEST_GUARDIAN_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockGuardianService.removeGuardian).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        TEST_PLAYER_ID,
        TEST_GUARDIAN_USER_ID,
        TEST_USER_ID
      );
    });

    it('returns 400 for a malformed guardianUserId', async () => {
      const res = await request(app).delete(`${base}/nope`);

      expect(res.status).toBe(400);
      expect(mockGuardianService.removeGuardian).not.toHaveBeenCalled();
    });

    it('returns 403 when the caller may not remove that guardian', async () => {
      mockGuardianService.removeGuardian.mockRejectedValue(new ForbiddenError('no'));

      const res = await request(app).delete(`${base}/${TEST_GUARDIAN_USER_ID}`);

      expect(res.status).toBe(403);
    });

    it('returns 404 when the link does not exist', async () => {
      mockGuardianService.removeGuardian.mockRejectedValue(new NotFoundError('Guardian link not found'));

      const res = await request(app).delete(`${base}/${TEST_GUARDIAN_USER_ID}`);

      expect(res.status).toBe(404);
    });

    it('returns 500 on unexpected errors', async () => {
      mockGuardianService.removeGuardian.mockRejectedValue(new Error('boom'));

      const res = await request(app).delete(`${base}/${TEST_GUARDIAN_USER_ID}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to remove guardian');
    });
  });
});
