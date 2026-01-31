/**
 * Invitations API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { InvitationService } from '../../src/services/invitation-service';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../src/utils/errors';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      role: 'PLAYER',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the service
jest.mock('../../src/services/invitation-service');

const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;

describe('Invitations API', () => {
  const mockInvitation = {
    id: 'inv-1',
    teamId: 'team-1',
    playerId: 'player-1',
    invitedById: 'coach-1',
    status: 'PENDING',
    token: 'abc123',
    message: 'Join our team!',
    jerseyNumber: 23,
    position: 'Guard',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    createdAt: new Date(),
    updatedAt: new Date(),
    team: {
      id: 'team-1',
      name: 'Lakers',
      league: { id: 'league-1', name: 'Spring League', season: 'Spring', year: 2024 },
    },
    player: { id: 'player-1', name: 'John Player', email: 'john@example.com' },
    invitedBy: { id: 'coach-1', name: 'Coach Smith', email: 'coach@example.com' },
  };

  const mockTeamMember = {
    id: 'tm-1',
    teamId: 'team-1',
    playerId: 'player-1',
    jerseyNumber: 23,
    position: 'Guard',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/invitations', () => {
    it('should list invitations successfully', async () => {
      mockInvitationService.listInvitations.mockResolvedValue({
        invitations: [mockInvitation],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/invitations');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.invitations).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should filter invitations by status', async () => {
      mockInvitationService.listInvitations.mockResolvedValue({
        invitations: [mockInvitation],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/invitations')
        .query({ status: 'PENDING' });

      expect(response.status).toBe(200);
      expect(mockInvitationService.listInvitations).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PENDING' }),
        'test-user-id'
      );
    });

    it('should filter invitations by teamId', async () => {
      const teamUuid = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
      mockInvitationService.listInvitations.mockResolvedValue({
        invitations: [mockInvitation],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/invitations')
        .query({ teamId: teamUuid });

      expect(response.status).toBe(200);
      expect(mockInvitationService.listInvitations).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: teamUuid }),
        'test-user-id'
      );
    });

    it('should support pagination', async () => {
      mockInvitationService.listInvitations.mockResolvedValue({
        invitations: [mockInvitation],
        pagination: { total: 25, limit: 10, offset: 10, hasMore: true },
      } as any);

      const response = await request(app)
        .get('/api/v1/invitations')
        .query({ limit: 10, offset: 10 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /api/v1/invitations/:id', () => {
    it('should get an invitation by ID', async () => {
      mockInvitationService.getInvitationById.mockResolvedValue(mockInvitation as any);

      const response = await request(app).get('/api/v1/invitations/inv-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.invitation.id).toBe('inv-1');
    });

    it('should return 404 for non-existent invitation', async () => {
      mockInvitationService.getInvitationById.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );

      const response = await request(app).get('/api/v1/invitations/invalid-id');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Invitation not found');
    });

    it('should return 403 for forbidden access', async () => {
      mockInvitationService.getInvitationById.mockRejectedValue(
        new ForbiddenError('Access denied')
      );

      const response = await request(app).get('/api/v1/invitations/inv-1');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });
  });

  describe('POST /api/v1/invitations/:id/accept', () => {
    it('should accept an invitation successfully', async () => {
      const acceptedInvitation = { ...mockInvitation, status: 'ACCEPTED' };
      mockInvitationService.acceptInvitation.mockResolvedValue({
        invitation: acceptedInvitation,
        teamMember: mockTeamMember,
      } as any);

      const response = await request(app).post('/api/v1/invitations/inv-1/accept');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.invitation.status).toBe('ACCEPTED');
      expect(response.body.teamMember).toBeDefined();
      expect(response.body.message).toContain('Invitation accepted');
    });

    it('should return 404 for non-existent invitation', async () => {
      mockInvitationService.acceptInvitation.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );

      const response = await request(app).post('/api/v1/invitations/invalid-id/accept');

      expect(response.status).toBe(404);
    });

    it('should return 400 for already accepted invitation', async () => {
      mockInvitationService.acceptInvitation.mockRejectedValue(
        new BadRequestError('Invitation already accepted')
      );

      const response = await request(app).post('/api/v1/invitations/inv-1/accept');

      expect(response.status).toBe(400);
    });

    it('should return 403 if not the invited player', async () => {
      mockInvitationService.acceptInvitation.mockRejectedValue(
        new ForbiddenError('Only the invited player can accept')
      );

      const response = await request(app).post('/api/v1/invitations/inv-1/accept');

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/invitations/:id/reject', () => {
    it('should reject an invitation successfully', async () => {
      const rejectedInvitation = { ...mockInvitation, status: 'REJECTED' };
      mockInvitationService.rejectInvitation.mockResolvedValue(rejectedInvitation as any);

      const response = await request(app).post('/api/v1/invitations/inv-1/reject');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.invitation.status).toBe('REJECTED');
      expect(response.body.message).toContain('Invitation rejected');
    });

    it('should return 404 for non-existent invitation', async () => {
      mockInvitationService.rejectInvitation.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );

      const response = await request(app).post('/api/v1/invitations/invalid-id/reject');

      expect(response.status).toBe(404);
    });

    it('should return 400 for already rejected invitation', async () => {
      mockInvitationService.rejectInvitation.mockRejectedValue(
        new BadRequestError('Invitation already rejected')
      );

      const response = await request(app).post('/api/v1/invitations/inv-1/reject');

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/invitations/:id', () => {
    it('should cancel an invitation successfully', async () => {
      const cancelledInvitation = { ...mockInvitation, status: 'CANCELLED' };
      mockInvitationService.cancelInvitation.mockResolvedValue(cancelledInvitation as any);

      const response = await request(app).delete('/api/v1/invitations/inv-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('Invitation cancelled');
    });

    it('should return 404 for non-existent invitation', async () => {
      mockInvitationService.cancelInvitation.mockRejectedValue(
        new NotFoundError('Invitation not found')
      );

      const response = await request(app).delete('/api/v1/invitations/invalid-id');

      expect(response.status).toBe(404);
    });

    it('should return 403 if not the coach who created it', async () => {
      mockInvitationService.cancelInvitation.mockRejectedValue(
        new ForbiddenError('Only the inviting coach can cancel')
      );

      const response = await request(app).delete('/api/v1/invitations/inv-1');

      expect(response.status).toBe(403);
    });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
