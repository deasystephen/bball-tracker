/**
 * Tests for useInvitations hooks
 *
 * Tests query key generation and data types.
 */

import {
  invitationKeys,
  TeamInvitation,
  InvitationStatus,
  CreateInvitationInput,
  InvitationsQueryParams,
} from '../../hooks/useInvitations';

describe('useInvitations', () => {
  describe('invitationKeys', () => {
    it('should generate base key correctly', () => {
      expect(invitationKeys.all).toEqual(['invitations']);
    });

    it('should generate lists key correctly', () => {
      expect(invitationKeys.lists()).toEqual(['invitations', 'list']);
    });

    it('should generate list key with no params', () => {
      expect(invitationKeys.list()).toEqual(['invitations', 'list', undefined]);
    });

    it('should generate list key with status param', () => {
      expect(invitationKeys.list({ status: 'PENDING' })).toEqual([
        'invitations',
        'list',
        { status: 'PENDING' },
      ]);
    });

    it('should generate list key with teamId param', () => {
      expect(invitationKeys.list({ teamId: 'team-1' })).toEqual([
        'invitations',
        'list',
        { teamId: 'team-1' },
      ]);
    });

    it('should generate list key with multiple params', () => {
      const params: InvitationsQueryParams = {
        status: 'PENDING',
        teamId: 'team-1',
        limit: 10,
        offset: 0,
      };
      expect(invitationKeys.list(params)).toEqual([
        'invitations',
        'list',
        params,
      ]);
    });

    it('should generate details key correctly', () => {
      expect(invitationKeys.details()).toEqual(['invitations', 'detail']);
    });

    it('should generate detail key for specific invitation', () => {
      expect(invitationKeys.detail('inv-123')).toEqual([
        'invitations',
        'detail',
        'inv-123',
      ]);
    });

    it('should generate team key correctly', () => {
      expect(invitationKeys.team('team-1')).toEqual([
        'invitations',
        'team',
        'team-1',
      ]);
    });

    it('should generate player key correctly', () => {
      expect(invitationKeys.player('player-1')).toEqual([
        'invitations',
        'player',
        'player-1',
      ]);
    });
  });

  describe('InvitationStatus type', () => {
    it('should accept all valid status values', () => {
      const statuses: InvitationStatus[] = [
        'PENDING',
        'ACCEPTED',
        'REJECTED',
        'EXPIRED',
        'CANCELLED',
      ];

      statuses.forEach((status) => {
        expect(typeof status).toBe('string');
      });
    });
  });

  describe('TeamInvitation type', () => {
    const baseInvitation: TeamInvitation = {
      id: 'inv-1',
      teamId: 'team-1',
      playerId: 'player-1',
      invitedById: 'coach-1',
      status: 'PENDING',
      token: 'abc123',
      expiresAt: '2024-12-31T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      team: {
        id: 'team-1',
        name: 'Lakers',
        season: {
          id: 'season-1',
          name: 'Spring 2024',
          isActive: true,
          league: {
            id: 'league-1',
            name: 'Downtown Youth Basketball',
          },
        },
      },
      player: {
        id: 'player-1',
        name: 'John Doe',
        email: 'john@example.com',
      },
      invitedBy: {
        id: 'coach-1',
        name: 'Coach Smith',
        email: 'coach@example.com',
      },
    };

    it('should accept valid invitation object', () => {
      expect(baseInvitation.id).toBe('inv-1');
      expect(baseInvitation.status).toBe('PENDING');
    });

    it('should have required nested team data', () => {
      expect(baseInvitation.team.name).toBe('Lakers');
      expect(baseInvitation.team.season.league.name).toBe('Downtown Youth Basketball');
    });

    it('should have required player data', () => {
      expect(baseInvitation.player.name).toBe('John Doe');
      expect(baseInvitation.player.email).toBe('john@example.com');
    });

    it('should have required invitedBy data', () => {
      expect(baseInvitation.invitedBy.name).toBe('Coach Smith');
    });

    it('should accept optional jersey number', () => {
      const invitation: TeamInvitation = {
        ...baseInvitation,
        jerseyNumber: 23,
      };
      expect(invitation.jerseyNumber).toBe(23);
    });

    it('should accept optional position', () => {
      const invitation: TeamInvitation = {
        ...baseInvitation,
        position: 'Point Guard',
      };
      expect(invitation.position).toBe('Point Guard');
    });

    it('should accept optional message', () => {
      const invitation: TeamInvitation = {
        ...baseInvitation,
        message: 'Join our team!',
      };
      expect(invitation.message).toBe('Join our team!');
    });

    it('should accept accepted timestamp for accepted invitations', () => {
      const invitation: TeamInvitation = {
        ...baseInvitation,
        status: 'ACCEPTED',
        acceptedAt: '2024-01-02T00:00:00Z',
      };
      expect(invitation.acceptedAt).toBe('2024-01-02T00:00:00Z');
    });

    it('should accept rejected timestamp for rejected invitations', () => {
      const invitation: TeamInvitation = {
        ...baseInvitation,
        status: 'REJECTED',
        rejectedAt: '2024-01-02T00:00:00Z',
      };
      expect(invitation.rejectedAt).toBe('2024-01-02T00:00:00Z');
    });
  });

  describe('CreateInvitationInput type', () => {
    it('should accept minimal input with playerId', () => {
      const input: CreateInvitationInput = {
        playerId: 'player-1',
      };
      expect(input.playerId).toBe('player-1');
    });

    it('should accept input with jersey number', () => {
      const input: CreateInvitationInput = {
        playerId: 'player-1',
        jerseyNumber: 23,
      };
      expect(input.jerseyNumber).toBe(23);
    });

    it('should accept input with position', () => {
      const input: CreateInvitationInput = {
        playerId: 'player-1',
        position: 'Guard',
      };
      expect(input.position).toBe('Guard');
    });

    it('should accept input with message', () => {
      const input: CreateInvitationInput = {
        playerId: 'player-1',
        message: 'Welcome to the team!',
      };
      expect(input.message).toBe('Welcome to the team!');
    });

    it('should accept input with custom expiration', () => {
      const input: CreateInvitationInput = {
        playerId: 'player-1',
        expiresInDays: 14,
      };
      expect(input.expiresInDays).toBe(14);
    });

    it('should accept complete input', () => {
      const input: CreateInvitationInput = {
        playerId: 'player-1',
        jerseyNumber: 23,
        position: 'Point Guard',
        message: 'Join us!',
        expiresInDays: 7,
      };

      expect(input.playerId).toBe('player-1');
      expect(input.jerseyNumber).toBe(23);
      expect(input.position).toBe('Point Guard');
      expect(input.message).toBe('Join us!');
      expect(input.expiresInDays).toBe(7);
    });
  });

  describe('InvitationsQueryParams type', () => {
    it('should accept status filter', () => {
      const params: InvitationsQueryParams = {
        status: 'PENDING',
      };
      expect(params.status).toBe('PENDING');
    });

    it('should accept teamId filter', () => {
      const params: InvitationsQueryParams = {
        teamId: 'team-1',
      };
      expect(params.teamId).toBe('team-1');
    });

    it('should accept playerId filter', () => {
      const params: InvitationsQueryParams = {
        playerId: 'player-1',
      };
      expect(params.playerId).toBe('player-1');
    });

    it('should accept pagination params', () => {
      const params: InvitationsQueryParams = {
        limit: 20,
        offset: 10,
      };
      expect(params.limit).toBe(20);
      expect(params.offset).toBe(10);
    });

    it('should accept all params together', () => {
      const params: InvitationsQueryParams = {
        status: 'PENDING',
        teamId: 'team-1',
        playerId: 'player-1',
        limit: 10,
        offset: 0,
      };

      expect(params.status).toBe('PENDING');
      expect(params.teamId).toBe('team-1');
      expect(params.playerId).toBe('player-1');
      expect(params.limit).toBe(10);
      expect(params.offset).toBe(0);
    });
  });
});
