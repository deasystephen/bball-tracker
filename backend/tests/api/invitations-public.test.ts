/**
 * Integration tests for public invitation token endpoints (no auth required)
 */

import request from 'supertest';
import { app } from '../../src/index';
import { InvitationService } from '../../src/services/invitation-service';
import { NotFoundError, BadRequestError } from '../../src/utils/errors';
import { invitationTokenKey } from '../../src/api/middleware/rate-limit';
import type { Request } from 'express';

jest.mock('../../src/services/invitation-service');

const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;

const VALID_TOKEN = 'abc123defghijklmnop';

const mockInvitationDetails = {
  id: 'b2c3d4e5-f6a7-4901-a345-67890abcdef0',
  status: 'PENDING' as const,
  teamName: 'Lakers',
  inviterName: 'Coach Smith',
  position: 'Guard',
  jerseyNumber: 23,
  message: 'Join our team!',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

describe('Public Invitation Token API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/invitations/by-token/:token', () => {
    it('should return invitation details for a valid token', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);

      const res = await request(app).get(`/api/v1/invitations/by-token/${VALID_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation.teamName).toBe('Lakers');
      expect(res.body.invitation.inviterName).toBe('Coach Smith');
      expect(res.body.invitation).not.toHaveProperty('player');
      expect(mockInvitationService.getInvitationByToken).toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('should return 404 when token is not found', async () => {
      mockInvitationService.getInvitationByToken.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );

      const res = await request(app).get(`/api/v1/invitations/by-token/${VALID_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Invitation not found');
    });

    it('should return 400 for a token that fails format validation', async () => {
      const res = await request(app).get('/api/v1/invitations/by-token/!!bad!!');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid token format');
      expect(mockInvitationService.getInvitationByToken).not.toHaveBeenCalled();
    });

    it('should not require authentication', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);

      const res = await request(app)
        .get(`/api/v1/invitations/by-token/${VALID_TOKEN}`)
        .unset('Authorization');

      expect(res.status).toBe(200);
    });
  });

  describe('rate limiting (audit #36)', () => {
    it('keys the lookup limiter on the token, not the client IP', () => {
      const key = invitationTokenKey({ params: { token: 'tok-abc' }, ip: '203.0.113.7' } as unknown as Request);
      expect(key).toBe('invite-token:tok-abc');
      expect(key).not.toContain('203.0.113.7');
    });

    it('lets many distinct tokens be looked up from one IP (server-side rendering)', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);

      // More than the per-token cap (30) from a single IP. Kept under the
      // global apiRateLimit (100/min/IP) so the rest of this file still runs.
      for (let i = 0; i < 35; i += 1) {
        const res = await request(app).get(`/api/v1/invitations/by-token/many-tokens-${i}-abcdefgh`);
        expect(res.status).toBe(200);
      }
    });

    it('limits repeated lookups of a single token with 429', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);
      const token = 'single-token-limited-abcdefgh';
      let lastStatus = 200;
      for (let i = 0; i < 31; i += 1) {
        const res = await request(app).get(`/api/v1/invitations/by-token/${token}`);
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe('POST /api/v1/invitations/by-token/:token/accept', () => {
    it('should accept invitation and return success', async () => {
      const acceptResult = {
        invitation: { id: mockInvitationDetails.id, status: 'ACCEPTED' },
        teamMember: { teamId: 'team-id', playerId: 'player-id' },
      };
      mockInvitationService.acceptInvitationByToken.mockResolvedValue(acceptResult as unknown as Awaited<ReturnType<typeof mockInvitationService.acceptInvitationByToken>>);

      const res = await request(app)
        .post(`/api/v1/invitations/by-token/${VALID_TOKEN}/accept`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Invitation accepted. You have been added to the team.');
      expect(mockInvitationService.acceptInvitationByToken).toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('should return 400 when invitation is already accepted', async () => {
      mockInvitationService.acceptInvitationByToken.mockRejectedValue(
        new BadRequestError('This invitation has already been accepted')
      );

      const res = await request(app)
        .post(`/api/v1/invitations/by-token/${VALID_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This invitation has already been accepted');
    });

    it('should return 400 when invitation is expired', async () => {
      mockInvitationService.acceptInvitationByToken.mockRejectedValue(
        new BadRequestError('This invitation has expired')
      );

      const res = await request(app)
        .post(`/api/v1/invitations/by-token/${VALID_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This invitation has expired');
    });

    it('should return 404 when token is not found', async () => {
      mockInvitationService.acceptInvitationByToken.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );

      const res = await request(app)
        .post(`/api/v1/invitations/by-token/${VALID_TOKEN}/accept`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Invitation not found');
    });

    it('should return 400 for a token that fails format validation', async () => {
      const res = await request(app).post('/api/v1/invitations/by-token/!!bad!!/accept');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid token format');
      expect(mockInvitationService.acceptInvitationByToken).not.toHaveBeenCalled();
    });

    it('should not require authentication', async () => {
      const acceptResult = {
        invitation: { id: mockInvitationDetails.id, status: 'ACCEPTED' },
        teamMember: { teamId: 'team-id', playerId: 'player-id' },
      };
      mockInvitationService.acceptInvitationByToken.mockResolvedValue(acceptResult as unknown as Awaited<ReturnType<typeof mockInvitationService.acceptInvitationByToken>>);

      const res = await request(app)
        .post(`/api/v1/invitations/by-token/${VALID_TOKEN}/accept`)
        .unset('Authorization');

      expect(res.status).toBe(200);
    });
  });
});
