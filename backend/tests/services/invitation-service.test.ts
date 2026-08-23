/**
 * Unit tests for InvitationService
 */

import { InvitationService } from '../../src/services/invitation-service';
import { mockPrisma } from '../setup';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

const mockedMailerSend = (jest.requireMock('../../src/services/mailer') as unknown as { mailer: { send: jest.Mock } }).mailer.send;
import {
  createInvitation,
  createTeam,
  createAdmin,
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
import type { CreateInvitationInput } from '../../src/api/invitations/schemas';

// Helper to create valid invitation input
const createInvitationInput = (overrides: {
  playerId: string;
  expiresInDays?: number;
  message?: string;
  jerseyNumber?: number;
  position?: string;
}): CreateInvitationInput => ({
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

      // Audit #14: the row is read back with an explicit select that omits the
      // secret token, and the email link uses the freshly generated token.
      const createArgs = (mockPrisma.teamInvitation.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.select).toBeDefined();
      expect(createArgs.select).not.toHaveProperty('token');
      expect(createArgs.include).toBeUndefined();
      const generatedToken = createArgs.data.token as string;
      expect(generatedToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

      // Flush microtasks so the fire-and-forget mailer.send call resolves
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedMailerSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: player.email,
          variables: expect.objectContaining({
            acceptUrl: `https://capyhoops.com/invite/${generatedToken}`,
          }),
        })
      );
    });

    it('formats expiresAt in DEFAULT_TIMEZONE (audit #57)', async () => {
      const previous = process.env.DEFAULT_TIMEZONE;
      process.env.DEFAULT_TIMEZONE = 'America/Los_Angeles';
      try {
        const coach = createCoach();
        const player = createPlayer();
        const league = createLeague();
        const season = createSeason({ leagueId: league.id });
        const team = createTeam({ seasonId: season.id });
        const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });
        const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
        const invitation = createInvitation({
          teamId: team.id,
          playerId: player.id,
          invitedById: coach.id,
          // 02:30Z on the 16th is still the 15th in Los Angeles.
          expiresAt: new Date('2026-03-16T02:30:00Z'),
        });

        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
        (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
          ...invitation,
          team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
          player: { id: player.id, name: player.name, email: player.email },
          invitedBy: { id: coach.id, name: coach.name, email: coach.email },
        });

        await InvitationService.createInvitation(team.id, createInvitationInput({ playerId: player.id }), coach.id);
        await new Promise((resolve) => setImmediate(resolve));

        expect(mockedMailerSend).toHaveBeenCalledWith(
          expect.objectContaining({
            to: player.email,
            variables: expect.objectContaining({ expiresAt: 'Mar 15, 2026' }),
          })
        );
      } finally {
        if (previous === undefined) delete process.env.DEFAULT_TIMEZONE;
        else process.env.DEFAULT_TIMEZONE = previous;
      }
    });

    it('uses PUBLIC_APP_URL env var for invite link when set', async () => {
      const previous = process.env.PUBLIC_APP_URL;
      process.env.PUBLIC_APP_URL = 'https://staging.capyhoops.com';
      try {
        const coach = createCoach();
        const player = createPlayer();
        const league = createLeague();
        const season = createSeason({ leagueId: league.id });
        const team = createTeam({ seasonId: season.id });
        const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
        const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
        const invitation = createInvitation({ teamId: team.id, playerId: player.id, invitedById: coach.id });

        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
        (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
          ...invitation,
          team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
          player: { id: player.id, name: player.name, email: player.email },
          invitedBy: { id: coach.id, name: coach.name, email: coach.email },
        });

        await InvitationService.createInvitation(team.id, { playerId: player.id, expiresInDays: 7 }, coach.id);
        const generatedToken = (mockPrisma.teamInvitation.create as jest.Mock).mock.calls[0][0].data.token;

        await new Promise((resolve) => setImmediate(resolve));
        expect(mockedMailerSend).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: expect.objectContaining({
              acceptUrl: `https://staging.capyhoops.com/invite/${generatedToken}`,
            }),
          })
        );
      } finally {
        if (previous === undefined) delete process.env.PUBLIC_APP_URL;
        else process.env.PUBLIC_APP_URL = previous;
      }
    });

    it('does not surface email send failures to the caller', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const invitation = createInvitation({ teamId: team.id, playerId: player.id, invitedById: coach.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
        ...invitation,
        team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });
      mockedMailerSend.mockRejectedValueOnce(new Error('SES down'));

      await expect(
        InvitationService.createInvitation(team.id, { playerId: player.id, expiresInDays: 7 }, coach.id)
      ).resolves.toHaveProperty('id', invitation.id);

      await Promise.resolve();
    });

    describe('create-and-invite with name + email (audit #69)', () => {
      const setupCoachTeam = (): {
        coach: ReturnType<typeof createCoach>;
        team: ReturnType<typeof createTeam>;
        season: ReturnType<typeof createSeason>;
        league: ReturnType<typeof createLeague>;
      } => {
        const coach = createCoach();
        const league = createLeague();
        const season = createSeason({ leagueId: league.id });
        const team = createTeam({ seasonId: season.id });
        const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
        const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
        return { coach, team, season, league };
      };

      it('creates the user and the invitation in one transaction when the email is new', async () => {
        const { coach, team, season, league } = setupCoachTeam();
        const created = createInvitation({ teamId: team.id, playerId: 'new-user-id', invitedById: coach.id });
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
        const txUserCreate = jest.fn().mockResolvedValue({ id: 'new-user-id' });
        const txInvitationCreate = jest.fn().mockResolvedValue({
          ...created,
          team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
          player: { id: 'new-user-id', name: 'Jane Hooper', email: 'jane@example.com' },
          invitedBy: { id: coach.id, name: coach.name, email: coach.email },
        });
        (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
          callback({ user: { create: txUserCreate }, teamInvitation: { create: txInvitationCreate } })
        );

        const result = await InvitationService.createInvitation(
          team.id,
          { name: 'Jane Hooper', email: 'jane@example.com', expiresInDays: 7, jerseyNumber: 7 },
          coach.id
        );

        expect(result).toHaveProperty('id', created.id);
        expect(txUserCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ name: 'Jane Hooper', email: 'jane@example.com', role: 'PLAYER' }),
          })
        );
        expect(txInvitationCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ teamId: team.id, playerId: 'new-user-id', jerseyNumber: 7 }),
          })
        );
        // Nothing is written outside the transaction, so a failed invite leaves no orphan user
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockPrisma.teamInvitation.create).not.toHaveBeenCalled();

        await new Promise((resolve) => setImmediate(resolve));
        expect(mockedMailerSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@example.com' }));
      });

      it('reuses an existing account with that email instead of failing', async () => {
        const { coach, team, season, league } = setupCoachTeam();
        const existing = createPlayer({ email: 'jane@example.com' });
        const created = createInvitation({ teamId: team.id, playerId: existing.id, invitedById: coach.id });
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(existing);
        (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
          ...created,
          team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
          player: { id: existing.id, name: existing.name, email: existing.email },
          invitedBy: { id: coach.id, name: coach.name, email: coach.email },
        });

        const result = await InvitationService.createInvitation(
          team.id,
          { name: 'Jane', email: 'jane@example.com', expiresInDays: 7 },
          coach.id
        );

        expect(result).toHaveProperty('playerId', existing.id);
        expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'jane@example.com' } });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.teamInvitation.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ playerId: existing.id }) })
        );
      });

      it('rejects when the existing account is already on the team', async () => {
        const { coach, team } = setupCoachTeam();
        const existing = createPlayer({ email: 'jane@example.com' });
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(existing);
        (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(
          createTeamMember({ teamId: team.id, playerId: existing.id })
        );

        await expect(
          InvitationService.createInvitation(
            team.id,
            { name: 'Jane', email: 'jane@example.com', expiresInDays: 7 },
            coach.id
          )
        ).rejects.toMatchObject({ statusCode: 400, message: 'Player is already on this team' });
        expect(mockPrisma.teamInvitation.create).not.toHaveBeenCalled();
      });
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

    it('lazily expires a stale PENDING invitation and creates a new one (audit #23)', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const stale = createInvitation({
        teamId: team.id,
        playerId: player.id,
        invitedById: coach.id,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      const fresh = createInvitation({ teamId: team.id, playerId: player.id, invitedById: coach.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(stale);
      (mockPrisma.teamInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
        ...fresh,
        team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
        player: { id: player.id, name: player.name, email: player.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });

      const result = await InvitationService.createInvitation(
        team.id,
        createInvitationInput({ playerId: player.id }),
        coach.id
      );

      expect(result).toHaveProperty('id', fresh.id);
      expect(mockPrisma.teamInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: stale.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      expect(mockPrisma.teamInvitation.create).toHaveBeenCalled();
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
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const mockTx = {
          teamInvitation: {
            updateMany: txUpdateMany,
            findUniqueOrThrow: jest.fn().mockResolvedValue({
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
      // Audit #58: the status flip is guarded by a PENDING predicate
      expect(txUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: invitation.id, status: 'PENDING' } })
      );
    });

    it('returns 400 (not 500) when a concurrent accept already moved it out of PENDING', async () => {
      const { invitation, player } = createFullInvitation();
      const txMemberCreate = jest.fn();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUniqueOrThrow: jest.fn(),
          },
          teamMember: { create: txMemberCreate },
        })
      );

      await expect(
        InvitationService.acceptInvitation(invitation.id, player.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Cannot accept invitation: it is no longer pending',
      });
      expect(txMemberCreate).not.toHaveBeenCalled();
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
      (mockPrisma.teamInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(
        InvitationService.acceptInvitation(invitation.id, player.id)
      ).rejects.toMatchObject({ statusCode: 400, message: 'This invitation has expired' });
      expect(mockPrisma.teamInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
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

    it('should filter by teamId when the user has team access', async () => {
      const { team, coach, season, league } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      // canAccessTeam: coach is staff on the team
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

      await InvitationService.listInvitations(
        { teamId: team.id, limit: 10, offset: 0 },
        coach.id
      );

      const findArgs = (mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where.teamId).toBe(team.id);
    });

    it('lists every invitation for the team when the caller can manage the roster (audit #23)', async () => {
      const { team, coach, season, league } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      // hasTeamPermission(canManageRoster)
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

      await InvitationService.listInvitations({ teamId: team.id, limit: 10, offset: 0 }, coach.id);

      const findArgs = (mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toEqual({ teamId: team.id });
      expect(findArgs.where).not.toHaveProperty('playerId');
    });

    it('scopes a rostered player (no roster permission) to their own invitations when filtering by teamId', async () => {
      const { team, player, season, league } = createFullInvitation();

      // canAccessTeam: not admin, not staff, but a team member
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(
        createTeamMember({ teamId: team.id, playerId: player.id })
      );
      // hasTeamPermission: no staff roles
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

      await InvitationService.listInvitations({ teamId: team.id, limit: 10, offset: 0 }, player.id);

      const findArgs = (mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toEqual({ teamId: team.id, playerId: player.id });
    });

    it('should throw ForbiddenError when filtering by a team the user cannot access', async () => {
      const team = createTeam();
      const outsider = createPlayer();

      // canAccessTeam: not admin, not staff, not member → false
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(outsider);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        InvitationService.listInvitations(
          { teamId: team.id, limit: 10, offset: 0 },
          outsider.id
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        message: "You do not have access to this team's invitations",
      });
    });

    describe("another player's invitations (role matrix B2.4)", () => {
      it('lets a system ADMIN list any player, unscoped', async () => {
        const admin = createAdmin();
        const otherPlayer = createPlayer();

        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
        (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

        await InvitationService.listInvitations({ playerId: otherPlayer.id, limit: 10, offset: 0 }, admin.id);

        const findArgs = (mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0];
        expect(findArgs.where).toEqual({ playerId: otherPlayer.id });
        expect(mockPrisma.teamMember.findMany).not.toHaveBeenCalled();
      });

      it('scopes a head coach to the teams the player is on that they manage', async () => {
        const coach = createCoach();
        const otherPlayer = createPlayer();

        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
        // getPlayerTeamAccess: player on two teams, coach manages the roster of one
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
          { teamId: 'team-managed', team: { season: { league: { admins: [] } }, staff: [{ id: 's1' }] } },
          { teamId: 'team-other', team: { season: { league: { admins: [] } }, staff: [] } },
        ]);
        (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

        await InvitationService.listInvitations({ playerId: otherPlayer.id, limit: 10, offset: 0 }, coach.id);

        const findArgs = (mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0];
        expect(findArgs.where).toEqual({ playerId: otherPlayer.id, teamId: { in: ['team-managed'] } });
        expect(mockPrisma.teamMember.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { playerId: otherPlayer.id } })
        );
      });

      it('rejects a self-selected COACH with no roster relationship to the player (403)', async () => {
        const coach = createCoach();
        const otherPlayer = createPlayer();

        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
          { teamId: 'team-other', team: { season: { league: { admins: [] } }, staff: [] } },
        ]);

        await expect(
          InvitationService.listInvitations({ playerId: otherPlayer.id, limit: 10, offset: 0 }, coach.id)
        ).rejects.toMatchObject({ statusCode: 403, message: 'You can only view your own invitations' });
        expect(mockPrisma.teamInvitation.findMany).not.toHaveBeenCalled();
      });

      it("throws ForbiddenError when a player lists another player's invitations", async () => {
        const requester = createPlayer();
        const otherPlayer = createPlayer();

        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(requester);
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

        await expect(
          InvitationService.listInvitations({ playerId: otherPlayer.id, limit: 10, offset: 0 }, requester.id)
        ).rejects.toMatchObject({ statusCode: 403, message: 'You can only view your own invitations' });
      });

      it('with teamId: allows a roster manager of that team and rejects a plain member', async () => {
        const { team, coach, player, season, league } = createFullInvitation();
        const otherPlayer = createPlayer();
        const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
        const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

        // Coach: canAccessTeam via staff, canManageRoster via role
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
          ...team,
          season: { ...season, league: { ...league, admins: [] } },
        });
        (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
        (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

        await InvitationService.listInvitations(
          { teamId: team.id, playerId: otherPlayer.id, limit: 10, offset: 0 },
          coach.id
        );
        const findArgs = (mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0];
        expect(findArgs.where).toEqual({ teamId: team.id, playerId: otherPlayer.id });

        // Rostered player: canAccessTeam via membership, no roster permission → 403
        jest.clearAllMocks();
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
          ...team,
          season: { ...season, league: { ...league, admins: [] } },
        });
        (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
        (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(
          createTeamMember({ teamId: team.id, playerId: player.id })
        );
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

        await expect(
          InvitationService.listInvitations(
            { teamId: team.id, playerId: otherPlayer.id, limit: 10, offset: 0 },
            player.id
          )
        ).rejects.toMatchObject({ statusCode: 403 });
      });
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

  describe('token is never selected on authenticated queries (audit #14)', () => {
    const expectSelectWithoutToken = (args: { select?: Record<string, unknown>; include?: unknown }): void => {
      expect(args.include).toBeUndefined();
      expect(args.select).toBeDefined();
      expect(args.select).not.toHaveProperty('token');
      expect(args.select).toHaveProperty('id', true);
      expect(args.select).toHaveProperty('status', true);
    };

    it('listInvitations selects without token', async () => {
      const { player } = createFullInvitation();
      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

      await InvitationService.listInvitations({ limit: 10, offset: 0 }, player.id);

      expectSelectWithoutToken((mockPrisma.teamInvitation.findMany as jest.Mock).mock.calls[0][0]);
    });

    it('getInvitationById selects without token', async () => {
      const { invitation, player } = createFullInvitation();
      const withoutToken: Partial<typeof invitation> = { ...invitation };
      delete withoutToken.token;
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(withoutToken);

      const result = await InvitationService.getInvitationById(invitation.id, player.id);

      expectSelectWithoutToken((mockPrisma.teamInvitation.findUnique as jest.Mock).mock.calls[0][0]);
      expect(result).not.toHaveProperty('token');
    });

    it('acceptInvitation updates with a select that omits token', async () => {
      const { invitation, player } = createFullInvitation();
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      const txFind = jest.fn().mockResolvedValue({ id: invitation.id, status: 'ACCEPTED' });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: txFind },
          teamMember: { create: jest.fn().mockResolvedValue({ teamId: invitation.teamId, playerId: player.id }) },
        })
      );

      await InvitationService.acceptInvitation(invitation.id, player.id);

      expectSelectWithoutToken(txFind.mock.calls[0][0]);
    });

    it('rejectInvitation updates with a select that omits token', async () => {
      const { invitation, player } = createFullInvitation();
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({ id: invitation.id, status: 'REJECTED' });

      await InvitationService.rejectInvitation(invitation.id, player.id);

      expectSelectWithoutToken((mockPrisma.teamInvitation.update as jest.Mock).mock.calls[0][0]);
    });

    it('cancelInvitation updates with a select that omits token', async () => {
      const { invitation, coach, team } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({ id: invitation.id, status: 'CANCELLED' });

      await InvitationService.cancelInvitation(invitation.id, coach.id);

      expectSelectWithoutToken((mockPrisma.teamInvitation.update as jest.Mock).mock.calls[0][0]);
    });
  });

  describe('getInvitationByToken', () => {
    it('should return public invitation details by token', async () => {
      const { invitation, team, coach } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue({
        ...invitation,
        team: { name: team.name },
        invitedBy: { name: coach.name },
      });

      const result = await InvitationService.getInvitationByToken(invitation.token);

      expect(result).toHaveProperty('id', invitation.id);
      expect(result).toHaveProperty('teamName', team.name);
      expect(result).toHaveProperty('inviterName', coach.name);
      expect(result).toHaveProperty('status', 'PENDING');
      expect(result).not.toHaveProperty('player');
    });

    it('should throw NotFoundError if token does not match any invitation', async () => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.getInvitationByToken('no-such-token');
      } catch (error) {
        expectNotFoundError(error, 'Invitation not found');
      }
    });
  });

  describe('acceptInvitationByToken', () => {
    it('should accept invitation by token', async () => {
      const { invitation, team, player } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const mockTx = {
          teamInvitation: {
            updateMany: txUpdateMany,
            findUniqueOrThrow: jest.fn().mockResolvedValue({
              ...invitation,
              status: 'ACCEPTED',
              acceptedAt: new Date(),
            }),
          },
          teamMember: {
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: player.id,
            }),
          },
        };
        return callback(mockTx);
      });

      const result = await InvitationService.acceptInvitationByToken(invitation.token);

      expect(result.invitation).toHaveProperty('status', 'ACCEPTED');
      expect(result.teamMember).toHaveProperty('playerId', player.id);
      expect(txUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: invitation.id, status: 'PENDING' } })
      );
    });

    it('returns 400 when a concurrent accept already consumed the token', async () => {
      const { invitation } = createFullInvitation();
      const txMemberCreate = jest.fn();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUniqueOrThrow: jest.fn(),
          },
          teamMember: { create: txMemberCreate },
        })
      );

      await expect(
        InvitationService.acceptInvitationByToken(invitation.token)
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(txMemberCreate).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if token does not match', async () => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await InvitationService.acceptInvitationByToken('no-such-token');
      } catch (error) {
        expectNotFoundError(error, 'Invitation not found');
      }
    });

    it('should throw BadRequestError if invitation is already accepted', async () => {
      const { invitation } = createFullInvitation();
      const accepted = { ...invitation, status: 'ACCEPTED' };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(accepted);

      try {
        await InvitationService.acceptInvitationByToken(invitation.token);
      } catch (error) {
        expectBadRequestError(error, 'This invitation has already been accepted');
      }
    });

    it('should throw BadRequestError if invitation is rejected', async () => {
      const { invitation } = createFullInvitation();
      const rejected = { ...invitation, status: 'REJECTED' };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(rejected);

      try {
        await InvitationService.acceptInvitationByToken(invitation.token);
      } catch (error) {
        expectBadRequestError(error, 'This invitation has been rejected');
      }
    });

    it('should throw BadRequestError if invitation is cancelled', async () => {
      const { invitation } = createFullInvitation();
      const cancelled = { ...invitation, status: 'CANCELLED' };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(cancelled);

      try {
        await InvitationService.acceptInvitationByToken(invitation.token);
      } catch (error) {
        expectBadRequestError(error, 'This invitation has been cancelled');
      }
    });

    it('should throw BadRequestError if invitation is expired', async () => {
      const { invitation } = createFullInvitation();
      const expired = {
        ...invitation,
        expiresAt: new Date(Date.now() - 86400000),
      };

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(expired);
      (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({
        ...expired,
        status: 'EXPIRED',
      });

      try {
        await InvitationService.acceptInvitationByToken(invitation.token);
      } catch (error) {
        expectBadRequestError(error, 'This invitation has expired');
      }
    });

    it('should throw BadRequestError if player is already on team', async () => {
      const { invitation, team, player } = createFullInvitation();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);

      try {
        await InvitationService.acceptInvitationByToken(invitation.token);
      } catch (error) {
        expectBadRequestError(error, 'You are already on this team');
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
