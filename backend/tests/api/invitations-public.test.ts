/**
 * Integration tests for public invitation token endpoints (no auth required)
 */

import request from 'supertest';
import { app } from '../../src/index';
import { InvitationService } from '../../src/services/invitation-service';
import { GuardianService } from '../../src/services/guardian-service';
import { NotFoundError, BadRequestError } from '../../src/utils/errors';
import { invitationTokenKey } from '../../src/api/middleware/rate-limit';
import type { Request } from 'express';
import { invitationViewState } from '../../src/api/invitations/public-routes';
import { domainEvent, spyOnInfo } from '../support/domain-events';

jest.mock('../../src/services/invitation-service');
jest.mock('../../src/services/guardian-service');

const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;
const mockGuardianService = GuardianService as jest.Mocked<typeof GuardianService>;

const mockGuardianInvitationDetails = {
  kind: 'guardian' as const,
  id: 'c3d4e5f6-a7b8-4012-a456-7890abcdef01',
  status: 'PENDING' as const,
  childName: 'Kid Smith',
  childDeletedAt: null,
  teamName: 'Lakers',
  inviterName: 'Coach Smith',
  inviterDeletedAt: null,
  relationship: 'MOTHER' as const,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

const VALID_TOKEN = 'abc123defghijklmnop';

function future(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

const mockInvitationDetails = {
  id: 'b2c3d4e5-f6a7-4901-a345-67890abcdef0',
  status: 'PENDING' as const,
  teamName: 'Lakers',
  inviterName: 'Coach Smith',
  inviterDeletedAt: null,
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
      expect(res.body.invitation.inviterDeletedAt).toBeNull();
      expect(mockInvitationService.getInvitationByToken).toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('carries the tombstone signal for a sender who deleted their account, and never an email (#642)', async () => {
      const inviterDeletedAt = '2026-09-01T00:00:00.000Z';
      mockInvitationService.getInvitationByToken.mockResolvedValue({
        ...mockInvitationDetails,
        inviterName: 'Deleted user',
        inviterDeletedAt,
      });

      const res = await request(app).get(`/api/v1/invitations/by-token/${VALID_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation.inviterDeletedAt).toBe(inviterDeletedAt);
      expect(JSON.stringify(res.body)).not.toContain('email');
    });

    it('tags a team invitation with kind: "team"', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);

      const res = await request(app).get(`/api/v1/invitations/by-token/${VALID_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation.kind).toBe('team');
      expect(mockGuardianService.getInvitationByToken).not.toHaveBeenCalled();
    });

    it('falls through to a guardian invitation (kind: "guardian") when no team invitation matches', async () => {
      mockInvitationService.getInvitationByToken.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );
      mockGuardianService.getInvitationByToken.mockResolvedValue(mockGuardianInvitationDetails);

      const res = await request(app).get(`/api/v1/invitations/by-token/${VALID_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation).toEqual(mockGuardianInvitationDetails);
      expect(res.body.invitation.kind).toBe('guardian');
      expect(res.body.invitation.childName).toBe('Kid Smith');
      expect(mockGuardianService.getInvitationByToken).toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('should return 404 when token is not found', async () => {
      mockInvitationService.getInvitationByToken.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );
      mockGuardianService.getInvitationByToken.mockRejectedValue(
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

  describe('Invitation viewed by token (#964, the invite funnel)', () => {
    // Distinct tokens per test: the per-token limiter (30) is shared across the file.
    const VIEW_TOKEN = 'funnel-view-token-abcdefgh';
    const past = new Date(Date.now() - 60_000).toISOString();

    it('logs one line with id, kind, state and the web client, and never the token', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);
      const info = spyOnInfo();

      const res = await request(app)
        .get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-web`)
        .set('X-Hooplings-Client', 'web');

      expect(res.status).toBe(200);
      expect(domainEvent(info, 'Invitation viewed by token')).toEqual({
        invitationId: mockInvitationDetails.id,
        kind: 'team',
        state: 'pending',
        client: 'web',
      });
      // Nothing logged during the request carries the token, the team name or the message.
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain(`${VIEW_TOKEN}-web`);
      expect(logged).not.toContain('Lakers');
      expect(logged).not.toContain('Join our team!');
    });

    it('tells the app from the web site by client, and logs null when the header is absent or invalid', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);
      const info = spyOnInfo();

      await request(app)
        .get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-app`)
        .set('X-Hooplings-Client', 'ios/1.6.0+embedded');
      expect(domainEvent(info, 'Invitation viewed by token').client).toBe('ios/1.6.0+embedded');

      info.mockClear();
      await request(app).get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-none`);
      expect(domainEvent(info, 'Invitation viewed by token').client).toBeNull();

      info.mockClear();
      await request(app)
        .get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-bad`)
        .set('X-Hooplings-Client', 'Mozilla/5.0');
      expect(domainEvent(info, 'Invitation viewed by token').client).toBeNull();
    });

    it('logs kind guardian and the state the recipient saw', async () => {
      mockInvitationService.getInvitationByToken.mockRejectedValue(new NotFoundError('Invitation not found'));
      mockGuardianService.getInvitationByToken.mockResolvedValue({
        ...mockGuardianInvitationDetails,
        status: 'ACCEPTED',
      });
      const info = spyOnInfo();

      await request(app).get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-guardian`).set('X-Hooplings-Client', 'web');

      expect(domainEvent(info, 'Invitation viewed by token')).toEqual({
        invitationId: mockGuardianInvitationDetails.id,
        kind: 'guardian',
        state: 'accepted',
        client: 'web',
      });
      expect(JSON.stringify(info.mock.calls)).not.toContain('Kid Smith');
    });

    it('reads a PENDING row past its expiry as expired', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue({ ...mockInvitationDetails, expiresAt: past });
      const info = spyOnInfo();

      await request(app).get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-expired`);

      expect(domainEvent(info, 'Invitation viewed by token').state).toBe('expired');
    });

    it('logs no view for a 404 or a malformed token (the HTTP request line covers those)', async () => {
      mockInvitationService.getInvitationByToken.mockRejectedValue(new NotFoundError('Invitation not found'));
      mockGuardianService.getInvitationByToken.mockRejectedValue(new NotFoundError('Invitation not found'));
      const info = spyOnInfo();

      expect((await request(app).get(`/api/v1/invitations/by-token/${VIEW_TOKEN}-missing`)).status).toBe(404);
      expect((await request(app).get('/api/v1/invitations/by-token/!!bad!!')).status).toBe(400);

      expect(info.mock.calls.filter(([msg]) => msg === 'Invitation viewed by token')).toHaveLength(0);
    });

    it.each([
      ['PENDING', future(), 'pending'],
      ['PENDING', new Date(Date.now() - 1).toISOString(), 'expired'],
      ['EXPIRED', future(), 'expired'],
      ['ACCEPTED', past, 'accepted'],
      ['REJECTED', future(), 'rejected'],
      ['CANCELLED', future(), 'cancelled'],
    ] as const)('maps status %s (expires %s) to state %s', (status, expiresAt, state) => {
      expect(invitationViewState({ status, expiresAt })).toBe(state);
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

      // More than the per-token cap (30) from a single IP.
      for (let i = 0; i < 35; i += 1) {
        const res = await request(app).get(`/api/v1/invitations/by-token/many-tokens-${i}-abcdefgh`);
        expect(res.status).toBe(200);
      }
    });

    // #718: the SSR invite page reaches the API from one egress IP, so the
    // global IP-keyed apiRateLimit (100/min) must not gate the lookup. Its own
    // looser IP ceiling is exhausted in invitation-lookup-rate-limit.test.ts.
    it('exempts the lookup from the global 100/min IP limit', async () => {
      mockInvitationService.getInvitationByToken.mockResolvedValue(mockInvitationDetails);

      for (let i = 0; i < 120; i += 1) {
        const res = await request(app).get(`/api/v1/invitations/by-token/ssr-egress-${i}-abcdefgh`);
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

    it('accepts a guardian invitation (kind: "guardian") when no team invitation matches', async () => {
      mockInvitationService.acceptInvitationByToken.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );
      const guardian = {
        id: 'g-1',
        parentId: 'parent-1',
        childId: 'child-1',
        relationship: 'MOTHER' as const,
        isPrimary: true,
      };
      mockGuardianService.acceptInvitationByToken.mockResolvedValue({
        kind: 'guardian',
        invitation: {
          id: mockGuardianInvitationDetails.id,
          status: 'ACCEPTED',
        } as unknown as Awaited<ReturnType<typeof mockGuardianService.acceptInvitationByToken>>['invitation'],
        guardian,
      });

      const res = await request(app)
        .post(`/api/v1/invitations/by-token/${VALID_TOKEN}/accept`);

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('guardian');
      expect(res.body.guardian).toEqual(guardian);
      expect(res.body.invitation.status).toBe('ACCEPTED');
      expect(res.body).not.toHaveProperty('teamMember');
      expect(mockGuardianService.acceptInvitationByToken).toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('returns 400 when the guardian invitation is expired', async () => {
      mockInvitationService.acceptInvitationByToken.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );
      mockGuardianService.acceptInvitationByToken.mockRejectedValue(
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
      mockGuardianService.acceptInvitationByToken.mockRejectedValue(
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
