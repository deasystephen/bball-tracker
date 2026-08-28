/**
 * Unit tests for InvitationService
 */

import { InvitationService } from '../../src/services/invitation-service';
import { GuardianService } from '../../src/services/guardian-service';
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
  createUser,
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

      const { invitation: result, emailSent } = await InvitationService.createInvitation(
        team.id,
        createInvitationInput({ playerId: player.id, message: 'Join our team!' }),
        coach.id
      );

      expect(result).toHaveProperty('id', invitation.id);
      expect(result).toHaveProperty('playerId', player.id);
      expect(result).toHaveProperty('status', 'PENDING');
      expect(emailSent).toBe(true);
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

      // The invitation is committed either way; the failed send is reported
      // as emailSent: false instead of throwing (unification spec — silent
      // failures were invisible, SES-sandbox incident 2026-08-28).
      const result = await InvitationService.createInvitation(
        team.id,
        { playerId: player.id, expiresInDays: 7 },
        coach.id
      );
      expect(result.invitation).toHaveProperty('id', invitation.id);
      expect(result.emailSent).toBe(false);
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

        expect(result.invitation).toHaveProperty('id', created.id);
        expect(txUserCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              name: 'Jane Hooper',
              email: 'jane@example.com',
              role: 'PLAYER',
              // Unification spec T2: invite-created accounts are managed by
              // the inviting coach until claimed (chip derivation + B2.10).
              isManaged: true,
              managedById: coach.id,
            }),
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

        expect(result.invitation).toHaveProperty('playerId', existing.id);
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

      expect(result.invitation).toHaveProperty('id', fresh.id);
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
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const txUpsert = jest.fn().mockResolvedValue({
        teamId: team.id,
        playerId: player.id,
        player: { id: player.id, name: player.name, email: player.email },
        team: { id: team.id, name: team.name },
      });
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
          teamMember: { upsert: txUpsert },
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
      // Unification spec T4: membership is create-if-missing — never a blind
      // insert (case-2 players are rostered at creation) and never an
      // overwrite of coach-set jersey/position (empty update).
      expect(txUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            teamId_playerId: { teamId: invitation.teamId, playerId: invitation.playerId },
          },
          update: {},
        })
      );
    });

    it('returns 400 (not 500) when a concurrent accept already moved it out of PENDING', async () => {
      const { invitation, player } = createFullInvitation();
      const txMemberUpsert = jest.fn();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUniqueOrThrow: jest.fn(),
          },
          teamMember: { upsert: txMemberUpsert },
        })
      );

      await expect(
        InvitationService.acceptInvitation(invitation.id, player.id)
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Cannot accept invitation: it is no longer pending',
      });
      expect(txMemberUpsert).not.toHaveBeenCalled();
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

    it('accepts when the player is already rostered (unified add, case 2) — membership untouched', async () => {
      // CRITICAL regression guard (unification spec T4): players added through
      // the unified Add Player flow have a TeamMember row from creation; the
      // old blind insert would P2002 (pre-change code answered 400 instead of
      // accepting). Accept must flip the invitation and leave the row alone.
      const { invitation, team, player } = createFullInvitation();
      const existingMember = createTeamMember({
        teamId: team.id,
        playerId: player.id,
        jerseyNumber: 42,
      });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      const txUpsert = jest.fn().mockResolvedValue({
        ...existingMember,
        player: { id: player.id, name: player.name, email: player.email },
        team: { id: team.id, name: team.name },
      });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest
              .fn()
              .mockResolvedValue({ ...invitation, status: 'ACCEPTED', acceptedAt: new Date() }),
          },
          teamMember: { upsert: txUpsert },
        })
      );

      const result = await InvitationService.acceptInvitation(invitation.id, player.id);

      expect(result.invitation).toHaveProperty('status', 'ACCEPTED');
      expect(result.teamMember).toHaveProperty('jerseyNumber', 42);
      expect(txUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    });
  });

  describe('rejectInvitation', () => {
    /** Mock the reject/cancel transaction; returns the per-call spies. */
    const mockLifecycleTx = (finalRow: unknown): {
      txUpdateMany: jest.Mock;
      txCount: jest.Mock;
      txUserUpdateMany: jest.Mock;
      txFind: jest.Mock;
    } => {
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const txCount = jest.fn().mockResolvedValue(0);
      const txUserUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const txFind = jest.fn().mockResolvedValue(finalRow);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: { updateMany: txUpdateMany, count: txCount, findUniqueOrThrow: txFind },
          user: { updateMany: txUserUpdateMany },
        })
      );
      return { txUpdateMany, txCount, txUserUpdateMany, txFind };
    };

    it('should reject invitation successfully and strip the unclaimed email (spec T1)', async () => {
      const { invitation, player, team } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      const { txUpdateMany, txUserUpdateMany } = mockLifecycleTx({
        ...invitation,
        status: 'REJECTED',
        rejectedAt: new Date(),
        team: { id: team.id, name: team.name },
      });

      const result = await InvitationService.rejectInvitation(invitation.id, player.id);

      expect(result).toHaveProperty('status', 'REJECTED');
      expect(result).toHaveProperty('rejectedAt');
      // Status flip is PENDING-guarded (a racing accept can't be overwritten)
      expect(txUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: invitation.id, status: 'PENDING' } })
      );
      // Consent guard: the email is stripped only while the row is unclaimed —
      // otherwise syncUser would turn a later sign-up into silent membership.
      expect(txUserUpdateMany).toHaveBeenCalledWith({
        where: { id: invitation.playerId, workosUserId: null },
        data: { email: null },
      });
    });

    it('keeps the email when another live PENDING invitation still references it', async () => {
      const { invitation, player } = createFullInvitation();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      const { txCount, txUserUpdateMany } = mockLifecycleTx({ ...invitation, status: 'REJECTED' });
      txCount.mockResolvedValue(1); // another team's invite is still pending

      await InvitationService.rejectInvitation(invitation.id, player.id);

      expect(txUserUpdateMany).not.toHaveBeenCalled();
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
    it('should cancel invitation successfully and strip the unclaimed email (spec T1)', async () => {
      const { invitation, team, coach } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      const txUserUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(0),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ ...invitation, status: 'CANCELLED' }),
          },
          user: { updateMany: txUserUpdateMany },
        })
      );

      const result = await InvitationService.cancelInvitation(invitation.id, coach.id);

      expect(result).toHaveProperty('status', 'CANCELLED');
      expect(txUserUpdateMany).toHaveBeenCalledWith({
        where: { id: invitation.playerId, workosUserId: null },
        data: { email: null },
      });
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
    beforeEach(() => {
      // Default scope also pulls in the caller's children (guardian links)
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('includes invitations addressed to the caller\'s children in the default scope (guardian)', async () => {
      const parent = createUser({ role: 'PARENT' });
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([{ childId: 'child-1' }]);
      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

      await InvitationService.listInvitations({ limit: 20, offset: 0 }, parent.id);

      expect(mockPrisma.teamInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { playerId: { in: [parent.id, 'child-1'] } } })
      );
    });

    it('lets a guardian filter by their child\'s playerId', async () => {
      const parent = createUser({ role: 'PARENT' });
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-1' });
      (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue([]);

      await InvitationService.listInvitations({ playerId: 'child-1', limit: 20, offset: 0 }, parent.id);

      expect(mockPrisma.teamInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { playerId: 'child-1' } })
      );
    });

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

    it('acceptInvitation reads back with a select that omits token', async () => {
      const { invitation, player } = createFullInvitation();
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      const txFind = jest.fn().mockResolvedValue({ id: invitation.id, status: 'ACCEPTED' });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: txFind },
          teamMember: { upsert: jest.fn().mockResolvedValue({ teamId: invitation.teamId, playerId: player.id }) },
        })
      );

      await InvitationService.acceptInvitation(invitation.id, player.id);

      expectSelectWithoutToken(txFind.mock.calls[0][0]);
    });

    it('rejectInvitation reads back with a select that omits token', async () => {
      const { invitation, player } = createFullInvitation();
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      const txFind = jest.fn().mockResolvedValue({ id: invitation.id, status: 'REJECTED' });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(0),
            findUniqueOrThrow: txFind,
          },
          user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        })
      );

      await InvitationService.rejectInvitation(invitation.id, player.id);

      expectSelectWithoutToken(txFind.mock.calls[0][0]);
    });

    it('cancelInvitation reads back with a select that omits token', async () => {
      const { invitation, coach, team } = createFullInvitation();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      const txFind = jest.fn().mockResolvedValue({ id: invitation.id, status: 'CANCELLED' });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn().mockResolvedValue(0),
            findUniqueOrThrow: txFind,
          },
          user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        })
      );

      await InvitationService.cancelInvitation(invitation.id, coach.id);

      expectSelectWithoutToken(txFind.mock.calls[0][0]);
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
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const txUpsert = jest.fn().mockResolvedValue({
        teamId: team.id,
        playerId: player.id,
      });
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
          teamMember: { upsert: txUpsert },
        };
        return callback(mockTx);
      });

      const result = await InvitationService.acceptInvitationByToken(invitation.token);

      expect(result.invitation).toHaveProperty('status', 'ACCEPTED');
      expect(result.teamMember).toHaveProperty('playerId', player.id);
      expect(txUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: invitation.id, status: 'PENDING' } })
      );
      expect(txUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    });

    it('returns 400 when a concurrent accept already consumed the token', async () => {
      const { invitation } = createFullInvitation();
      const txMemberUpsert = jest.fn();

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findUniqueOrThrow: jest.fn(),
          },
          teamMember: { upsert: txMemberUpsert },
        })
      );

      await expect(
        InvitationService.acceptInvitationByToken(invitation.token)
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(txMemberUpsert).not.toHaveBeenCalled();
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

    it('accepts by token when the player is already rostered (unified add, case 2)', async () => {
      const { invitation, team, player } = createFullInvitation();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(invitation);
      const txUpsert = jest.fn().mockResolvedValue(member);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback) =>
        callback({
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest
              .fn()
              .mockResolvedValue({ ...invitation, status: 'ACCEPTED', acceptedAt: new Date() }),
          },
          teamMember: { upsert: txUpsert },
        })
      );

      const result = await InvitationService.acceptInvitationByToken(invitation.token);

      expect(result.invitation).toHaveProperty('status', 'ACCEPTED');
      expect(txUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    });
  });

  describe('addRosterPlayer (unified Add Player, unification spec)', () => {
    const setupCoachTeam = (): {
      coach: ReturnType<typeof createCoach>;
      team: ReturnType<typeof createTeam>;
    } => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      return { coach, team };
    };

    const invitationRow = (teamId: string, playerId: string, player: { id: string; name: string | null; email: string | null }): Record<string, unknown> => ({
      ...createInvitation({ teamId, playerId }),
      team: { id: teamId, name: 'Team', season: { id: 's', name: 'S', league: { id: 'l', name: 'L' } } },
      player,
      invitedBy: { id: 'coach', name: 'Coach', email: 'coach@example.com' },
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('case 1 — no email: managed user + membership, no invitation, no email', async () => {
      const { coach, team } = setupCoachTeam();
      const txUserCreate = jest.fn().mockResolvedValue({ id: 'managed-1' });
      const txMemberCreate = jest.fn().mockResolvedValue({
        teamId: team.id,
        playerId: 'managed-1',
        player: { id: 'managed-1', name: 'Kid', email: null, isManaged: true, managedById: coach.id },
        team: { id: team.id, name: team.name },
      });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) =>
        cb({ user: { create: txUserCreate }, teamMember: { create: txMemberCreate } })
      );

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Kid', jerseyNumber: 0 },
        coach.id
      );

      expect(result.rostered).toBe(true);
      expect(result.invited).toBe(false);
      expect(result.member).toHaveProperty('playerId', 'managed-1');
      expect(result.invitation).toBeNull();
      expect(result.emails).toEqual({});
      expect(txUserCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isManaged: true, managedById: coach.id, email: null }),
        })
      );
      // Jersey 0 is a valid number — must survive to the membership row
      expect(txMemberCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ jerseyNumber: 0 }) })
      );
      expect(mockedMailerSend).not.toHaveBeenCalled();
    });

    it('case 2 — new email: managed user + membership + invitation, "added" email awaited', async () => {
      const { coach, team } = setupCoachTeam();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      const txUserCreate = jest.fn().mockResolvedValue({ id: 'new-1' });
      const txMemberFind = jest.fn().mockResolvedValue(null);
      const txInvUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
      const txMemberCreate = jest.fn().mockResolvedValue({
        teamId: team.id,
        playerId: 'new-1',
        player: { id: 'new-1', name: 'Jane', email: 'jane@example.com', isManaged: true, managedById: coach.id },
        team: { id: team.id, name: team.name },
      });
      const txInvCreate = jest
        .fn()
        .mockResolvedValue(invitationRow(team.id, 'new-1', { id: 'new-1', name: 'Jane', email: 'jane@example.com' }));
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) =>
        cb({
          user: { create: txUserCreate },
          teamMember: { findUnique: txMemberFind, create: txMemberCreate },
          teamInvitation: { updateMany: txInvUpdateMany, create: txInvCreate },
        })
      );

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Jane', playerEmail: 'jane@example.com' },
        coach.id
      );

      expect(result.rostered).toBe(true);
      expect(result.invited).toBe(true);
      expect(result.member).toHaveProperty('playerId', 'new-1');
      expect(result.invitation).not.toBeNull();
      expect(result.invitation).not.toHaveProperty('token');
      expect(result.emails.player).toBe(true);
      expect(txUserCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isManaged: true, managedById: coach.id, email: 'jane@example.com' }),
        })
      );
      expect(mockedMailerSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jane@example.com',
          variables: expect.objectContaining({ variant: 'added' }),
        })
      );
    });

    it('case 2 — reports emails.player: false when the send fails, player still created', async () => {
      const { coach, team } = setupCoachTeam();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) =>
        cb({
          user: { create: jest.fn().mockResolvedValue({ id: 'new-1' }) },
          teamMember: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: 'new-1',
              player: { id: 'new-1', name: 'Jane', email: 'jane@example.com', isManaged: true, managedById: coach.id },
              team: { id: team.id, name: team.name },
            }),
          },
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            create: jest
              .fn()
              .mockResolvedValue(invitationRow(team.id, 'new-1', { id: 'new-1', name: 'Jane', email: 'jane@example.com' })),
          },
        })
      );
      mockedMailerSend.mockRejectedValueOnce(new Error('SES: address not verified'));

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Jane', playerEmail: 'jane@example.com' },
        coach.id
      );

      expect(result.rostered).toBe(true);
      expect(result.emails.player).toBe(false);
    });

    it('middle case — unclaimed pre-provisioned row is reused as case 2 (flags set, name untouched)', async () => {
      const { coach, team } = setupCoachTeam();
      const unclaimed = { ...createPlayer({ email: 'jane@example.com' }), workosUserId: null, managedById: null };
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(unclaimed);
      const txUserUpdate = jest.fn().mockResolvedValue(unclaimed);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) =>
        cb({
          user: { update: txUserUpdate },
          teamMember: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: unclaimed.id,
              player: { id: unclaimed.id, name: unclaimed.name, email: unclaimed.email, isManaged: true, managedById: coach.id },
              team: { id: team.id, name: team.name },
            }),
          },
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            create: jest
              .fn()
              .mockResolvedValue(invitationRow(team.id, unclaimed.id, { id: unclaimed.id, name: unclaimed.name, email: unclaimed.email })),
          },
        })
      );

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Jane', playerEmail: 'jane@example.com' },
        coach.id
      );

      expect(result.rostered).toBe(true);
      expect(txUserUpdate).toHaveBeenCalledWith({
        where: { id: unclaimed.id },
        data: { isManaged: true, managedById: coach.id },
      });
      // Never touch name/role of a row another flow provisioned
      expect(txUserUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: expect.anything() }) })
      );
    });

    it('case 3 — claimed account: invitation only, "invited" email, guardian deferred with reason', async () => {
      const { coach, team } = setupCoachTeam();
      const claimed = { ...createPlayer({ email: 'jane@example.com' }), workosUserId: 'workos-1' };
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(claimed);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue(
        invitationRow(team.id, claimed.id, { id: claimed.id, name: claimed.name, email: claimed.email })
      );
      const inviteGuardianSpy = jest.spyOn(GuardianService, 'inviteGuardian');

      const result = await InvitationService.addRosterPlayer(
        team.id,
        {
          name: 'Jane',
          playerEmail: 'jane@example.com',
          guardianEmail: 'mom@example.com',
          guardianRelationship: 'MOTHER',
        },
        coach.id
      );

      expect(result.rostered).toBe(false);
      expect(result.invited).toBe(true);
      expect(result.member).toBeNull();
      expect(result.invitation).not.toBeNull();
      expect(result.invitation).not.toHaveProperty('token');
      // Guardian requires a roster entry (guardian-service requireMember) —
      // never attempted for case 3, reported instead (review issue 1A).
      expect(result.guardianInvited).toBe(false);
      expect(result.guardianReason).toMatch(/after the player accepts/i);
      expect(inviteGuardianSpy).not.toHaveBeenCalled();
      expect(mockedMailerSend).toHaveBeenCalledWith(
        expect.objectContaining({ variables: expect.objectContaining({ variant: 'invited' }) })
      );
    });

    it('case 1 + guardianEmail — guardian invited through the existing guardian system', async () => {
      const { coach, team } = setupCoachTeam();
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) =>
        cb({
          user: { create: jest.fn().mockResolvedValue({ id: 'managed-1' }) },
          teamMember: {
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: 'managed-1',
              player: { id: 'managed-1', name: 'Kid', email: null, isManaged: true, managedById: coach.id },
              team: { id: team.id, name: team.name },
            }),
          },
        })
      );
      const inviteGuardianSpy = jest
        .spyOn(GuardianService, 'inviteGuardian')
        .mockResolvedValue({ id: 'gi-1', emailSent: true } as unknown as Awaited<ReturnType<typeof GuardianService.inviteGuardian>>);

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Kid', guardianEmail: 'mom@example.com', guardianRelationship: 'MOTHER' },
        coach.id
      );

      expect(result.guardianInvited).toBe(true);
      expect(result.emails.guardian).toBe(true);
      expect(inviteGuardianSpy).toHaveBeenCalledWith(
        team.id,
        'managed-1',
        { email: 'mom@example.com', relationship: 'MOTHER' },
        coach.id
      );
    });

    it('guardian failure does not fail the already-committed add', async () => {
      const { coach, team } = setupCoachTeam();
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) =>
        cb({
          user: { create: jest.fn().mockResolvedValue({ id: 'managed-1' }) },
          teamMember: {
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: 'managed-1',
              player: { id: 'managed-1', name: 'Kid', email: null, isManaged: true, managedById: coach.id },
              team: { id: team.id, name: team.name },
            }),
          },
        })
      );
      jest
        .spyOn(GuardianService, 'inviteGuardian')
        .mockRejectedValue(new Error('A pending guardian invitation already exists for this email'));

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Kid', guardianEmail: 'mom@example.com', guardianRelationship: 'MOTHER' },
        coach.id
      );

      expect(result.rostered).toBe(true);
      expect(result.guardianInvited).toBe(false);
      expect(result.guardianReason).toMatch(/already exists/i);
    });

    it('retries once against the winner when two coaches race the same new email (P2002)', async () => {
      const { coach, team } = setupCoachTeam();
      const raceWinner = { ...createPlayer({ email: 'jane@example.com' }), workosUserId: null, managedById: 'other-coach' };
      // Route by args: permission checks look users up by id; the email
      // lookup sees nobody first (pre-race) and the winner on the refetch.
      let emailLookups = 0;
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(
        ({ where }: { where: { email?: string; id?: string } }) => {
          if (where?.email) {
            emailLookups += 1;
            return Promise.resolve(emailLookups === 1 ? null : raceWinner);
          }
          return Promise.resolve(null);
        }
      );
      const p2002 = new (jest.requireActual('@prisma/client') as typeof import('@prisma/client')).Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        { code: 'P2002', clientVersion: 'test' }
      );
      let attempt = 0;
      const txUserUpdate = jest.fn().mockResolvedValue(raceWinner);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        attempt += 1;
        if (attempt === 1) {
          throw p2002;
        }
        return cb({
          user: { update: txUserUpdate },
          teamMember: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
              teamId: team.id,
              playerId: raceWinner.id,
              player: { id: raceWinner.id, name: raceWinner.name, email: raceWinner.email, isManaged: true, managedById: 'other-coach' },
              team: { id: team.id, name: team.name },
            }),
          },
          teamInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            create: jest
              .fn()
              .mockResolvedValue(invitationRow(team.id, raceWinner.id, { id: raceWinner.id, name: raceWinner.name, email: raceWinner.email })),
          },
        });
      });

      const result = await InvitationService.addRosterPlayer(
        team.id,
        { name: 'Jane', playerEmail: 'jane@example.com' },
        coach.id
      );

      expect(result.rostered).toBe(true);
      expect(attempt).toBe(2);
      // managedById belonged to the race winner's creator — left alone
      expect(txUserUpdate).toHaveBeenCalledWith({
        where: { id: raceWinner.id },
        data: { isManaged: true },
      });
    });

    it('403 when the caller cannot manage the roster', async () => {
      const outsider = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(outsider);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

      await expect(
        InvitationService.addRosterPlayer(team.id, { name: 'Kid' }, outsider.id)
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('supersede (resend path, unification spec D4-as-amended)', () => {
    it('expires the live PENDING invitation and creates a fresh one for a rostered managed player', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const managedPlayer = { ...createPlayer({ email: 'jane@example.com' }), workosUserId: null };
      const live = createInvitation({
        teamId: team.id,
        playerId: managedPlayer.id,
        expiresAt: new Date(Date.now() + 86400000), // still valid — would 400 without supersede
      });
      const fresh = createInvitation({ teamId: team.id, playerId: managedPlayer.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(managedPlayer);
      // Rostered at creation (case 2) — supersede allows the existing member
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(
        createTeamMember({ teamId: team.id, playerId: managedPlayer.id })
      );
      (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(live);
      (mockPrisma.teamInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
        ...fresh,
        team: { id: team.id, name: team.name, season: { id: season.id, name: season.name, league: { id: league.id, name: league.name } } },
        player: { id: managedPlayer.id, name: managedPlayer.name, email: managedPlayer.email },
        invitedBy: { id: coach.id, name: coach.name, email: coach.email },
      });

      const result = await InvitationService.createInvitation(
        team.id,
        { playerId: managedPlayer.id, supersede: true },
        coach.id
      );

      expect(result.invitation).toHaveProperty('id', fresh.id);
      // The old link dies: its row is expired (status-guarded)
      expect(mockPrisma.teamInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: live.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    });

    it('refuses to supersede for a claimed account that is already a member (Active)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const activePlayer = { ...createPlayer(), workosUserId: 'workos-1' };

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(activePlayer);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(
        createTeamMember({ teamId: team.id, playerId: activePlayer.id })
      );

      await expect(
        InvitationService.createInvitation(
          team.id,
          { playerId: activePlayer.id, supersede: true },
          coach.id
        )
      ).rejects.toMatchObject({ statusCode: 400, message: 'Player already has access to this team' });
      expect(mockPrisma.teamInvitation.create).not.toHaveBeenCalled();
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
