/**
 * Unit tests for InvitationService
 */

import { InvitationService } from '../../src/services/invitation-service';
import { mockPrisma } from '../setup';
import {
  createInvitation,
  createTeam,
  createCoach,
  createPlayer,
  createLeague,
  createSeason,
  createTeamMember,
  createFullInvitation,
  createTeamRole,
  createTeamStaff,
} from '../factories';
import {
  expectNotFoundError,
  expectBadRequestError,
  expectForbiddenError,
} from '../helpers';

// Helper to create valid invitation input
const createInvitationInput = (overrides: {
  playerId: string;
  expiresInDays?: number;
  message?: string;
  jerseyNumber?: number;
  position?: string;
}) => ({
  playerId: overrides.playerId,
  expiresInDays: overrides.expiresInDays ?? 7,
  message: overrides.message,
  jerseyNumber: overrides.jerseyNumber,
  position: overrides.position,
});

describe('InvitationService', () => {
  describe('createInvitation', () => {
    it('should create an invitation successfully', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const invitation = createInvitation({
        teamId: team.id,
        playerId: player.id,
        invitedById: coach.id,
      });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
        ...invitation,
        team: {
          id: team.id,
          name: team.name,
          season: {
            id: season.id,
            name: season.name,
            league: { id: league.id, name: league.name },
          },
        },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });

      const result = await InvitationService.createInvitation(
        team.id,
        createInvitationInput({ playerId: player.id, message: 'Join our team!' }),
        coach.id
      );

      expect(result).toHaveProperty('id', invitation.id);
      expect(result).toHaveProperty('playerId', player.id);
      expect(result).toHaveProperty('status', 'PENDING');
      expect(mockPrisma.teamInvitation.create).toHaveBeenCalled();
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.createInvitation(
          'non-existent',
          createInvitationInput({ playerId: 'player-id' }),
          'coach-id'
        );
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await InvitationService.createInvitation(
          team.id,
          createInvitationInput({ playerId: 'player-id' }),
          otherUser.id
        );
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to send invitations for this team');
      }
    });

    it('should throw NotFoundError if user does not exist', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.createInvitation(
          team.id,
          createInvitationInput({ playerId: 'non-existent' }),
          coach.id
        );
      } catch (error) {
        expectNotFoundError(error, 'User not found');
      }
    });

    it('should throw BadRequestError if player is already on team', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);

      try {
        await InvitationService.createInvitation(
          team.id,
          createInvitationInput({ playerId: player.id }),
          coach.id
        );
      } catch (error) {
        expectBadRequestError(error, 'Player is already on this team');
      }
    });

    it('should throw BadRequestError if pending invitation already exists', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const existingInvitation = createInvitation({
        teamId: team.id,
        playerId: player.id,
        status: 'PENDING',
      });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(existingInvitation);

      try {
        await InvitationService.createInvitation(
          team.id,
          createInvitationInput({ playerId: player.id }),
          coach.id
        );
      } catch (error) {
        expectBadRequestError(error, 'A pending invitation already exists for this player');
      }
    });
  });

  describe('acceptInvitation', () => {
    it('should accept invitation and add player to team', async () => {
      const { invitation, team, player } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const mockTx = {
          teamInvitation: {
            update: jest.fn().mockResolvedValue({
              ...invitation,
              status: 'ACCEPTED',
              acceptedAt: new Date(),
            }),
          },
          teamMember: {
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: player.id,
              player: { id: player.id, name: player.name, email: player.email },
              team: { id: team.id, name: team.name },
            }),
          },
        };
        return callback(mockTx);
      });

      const result = await InvitationService.acceptInvitation(invitation.id, player.id);

      expect(result.invitation).toHaveProperty('status', 'ACCEPTED');
      expect(result.teamMember).toHaveProperty('playerId', player.id);
    });

    it('should throw NotFoundError if invitation does not exist', async () => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.acceptInvitation('non-existent', 'player-id');
      } catch (error) {
        expectNotFoundError(error, 'Invitation not found');
      }
    });

    it('should throw ForbiddenError if user is not the invited player', async () => {
      const { invitation } = createFullInvitation();
      const otherUser = createPlayer();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);

      try {
        await InvitationService.acceptInvitation(invitation.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You can only accept your own invitations');
      }
    });

    it('should throw BadRequestError if invitation is not pending', async () => {
      const { invitation, player } = createFullInvitation();
      const acceptedInvitation = { ...invitation, status: 'ACCEPTED' };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(acceptedInvitation);

      try {
        await InvitationService.acceptInvitation(invitation.id, player.id);
      } catch (error) {
        expectBadRequestError(error, 'Cannot accept invitation with status: ACCEPTED');
      }
    });

    it('should throw BadRequestError if invitation is expired', async () => {
      const { invitation, player } = createFullInvitation();
      const expiredInvitation = {
        ...invitation,
        expiresAt: new Date(Date.now() - 86400000), // Yesterday
      };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(expiredInvitation);
      (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({
        ...expiredInvitation,
        status: 'EXPIRED',
      });

      try {
        await InvitationService.acceptInvitation(invitation.id, player.id);
      } catch (error) {
        expectBadRequestError(error, 'This invitation has expired');
      }
    });

    it('should throw BadRequestError if player is already on team', async () => {
      const { invitation, team, player } = createFullInvitation();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);

      try {
        await InvitationService.acceptInvitation(invitation.id, player.id);
      } catch (error) {
        expectBadRequestError(error, 'You are already on this team');
      }
    });
  });

  describe('rejectInvitation', () => {
    it('should reject invitation successfully', async () => {
      const { invitation, player, team } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({
        ...invitation,
        status: 'REJECTED',
        rejectedAt: new Date(),
        team: { id: team.id, name: team.name },
      });

      const result = await InvitationService.rejectInvitation(invitation.id, player.id);

      expect(result).toHaveProperty('status', 'REJECTED');
      expect(result).toHaveProperty('rejectedAt');
    });

    it('should throw NotFoundError if invitation does not exist', async () => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.rejectInvitation('non-existent', 'player-id');
      } catch (error) {
        expectNotFoundError(error, 'Invitation not found');
      }
    });

    it('should throw ForbiddenError if user is not the invited player', async () => {
      const { invitation } = createFullInvitation();
      const otherUser = createPlayer();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);

      try {
        await InvitationService.rejectInvitation(invitation.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You can only reject your own invitations');
      }
    });

    it('should throw BadRequestError if invitation is not pending', async () => {
      const { invitation, player } = createFullInvitation();
      const acceptedInvitation = { ...invitation, status: 'ACCEPTED' };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(acceptedInvitation);

      try {
        await InvitationService.rejectInvitation(invitation.id, player.id);
      } catch (error) {
        expectBadRequestError(error, 'Cannot reject invitation with status: ACCEPTED');
      }
    });
  });

  describe('cancelInvitation', () => {
    it('should cancel invitation successfully', async () => {
      const { invitation, team, coach } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({
        ...invitation,
        status: 'CANCELLED',
      });

      const result = await InvitationService.cancelInvitation(invitation.id, coach.id);

      expect(result).toHaveProperty('status', 'CANCELLED');
    });

    it('should throw NotFoundError if invitation does not exist', async () => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.cancelInvitation('non-existent', 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Invitation not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { invitation, team, season, league } = createFullInvitation();
      const otherUser = createPlayer();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await InvitationService.cancelInvitation(invitation.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to cancel invitations for this team');
      }
    });

    it('should throw BadRequestError if invitation is not pending', async () => {
      const { invitation, team, coach } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const acceptedInvitation = { ...invitation, status: 'ACCEPTED' };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(acceptedInvitation);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);

      try {
        await InvitationService.cancelInvitation(invitation.id, coach.id);
      } catch (error) {
        expectBadRequestError(error, 'Cannot cancel invitation with status: ACCEPTED');
      }
    });
  });

  describe('listInvitations', () => {
    it('should return invitations for a player', async () => {
      const { invitation, player, team, coach, league, season } = createFullInvitation();

      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([{
        ...invitation,
        team: {
          id: team.id,
          name: team.name,
          season: {
            id: season.id,
            name: season.name,
            league: { id: league.id, name: league.name },
          },
        },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      }]);

      const result = await InvitationService.listInvitations(
        { limit: 10, offset: 0 },
        player.id
      );

      expect(result.invitations).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });

    it('should filter by status', async () => {
      const { invitation, player, team, coach, league, season } = createFullInvitation();

      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([{
        ...invitation,
        team: {
          id: team.id,
          name: team.name,
          season: {
            id: season.id,
            name: season.name,
            league: { id: league.id, name: league.name },
          },
        },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      }]);

      const result = await InvitationService.listInvitations(
        { status: 'PENDING', limit: 10, offset: 0 },
        player.id
      );

      expect(result.invitations).toHaveLength(1);
    });
  });

  describe('getInvitationById', () => {
    it('should return invitation for user with team access', async () => {
      const { invitation, team, player, coach, league, season } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue({
        ...invitation,
        team: {
          id: team.id,
          name: team.name,
          season: {
            id: season.id,
            name: season.name,
            league: { id: league.id, name: league.name },
          },
        },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);

      const result = await InvitationService.getInvitationById(invitation.id, coach.id);

      expect(result).toHaveProperty('id', invitation.id);
    });

    it('should return invitation for invited player', async () => {
      const { invitation, team, player, coach, league, season } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue({
        ...invitation,
        team: {
          id: team.id,
          name: team.name,
          season: {
            id: season.id,
            name: season.name,
            league: { id: league.id, name: league.name },
          },
        },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await InvitationService.getInvitationById(invitation.id, player.id);

      expect(result).toHaveProperty('id', invitation.id);
    });

    it('should throw NotFoundError if invitation does not exist', async () => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.getInvitationById('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Invitation not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const { invitation, team, player, coach, league, season } = createFullInvitation();
      const otherUser = createPlayer();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue({
        ...invitation,
        team: {
          id: team.id,
          name: team.name,
          season: {
            id: season.id,
            name: season.name,
            league: { id: league.id, name: league.name },
          },
        },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await InvitationService.getInvitationById(invitation.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this invitation');
      }
    });
  });

  describe('expireOldInvitations', () => {
    it('should expire old pending invitations', async () => {
      (mockPrisma.teamInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 5 });

      const result = await InvitationService.expireOldInvitations();

      expect(result).toEqual({ count: 5 });
      expect(mockPrisma.teamInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PENDING',
            expiresAt: expect.objectContaining({ lt: expect.any(Date) }),
          }),
          data: { status: 'EXPIRED' },
        })
      );
    });
  });
});
