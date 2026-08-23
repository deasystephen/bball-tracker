/**
 * Unit tests for TeamService
 */

import { TeamService } from '../../src/services/team-service';
import { mockPrisma } from '../setup';
import {
  createAdmin,
  createCoach,
  createPlayer,
  createTeam,
  createSeason,
  createLeague,
  createTeamMember,
  createFullTeam,
  createTeamRole,
  createTeamStaff,
} from '../factories';
import {
  expectNotFoundError,
  expectBadRequestError,
  expectForbiddenError,
} from '../helpers';

describe('TeamService', () => {
  describe('createTeam', () => {
    it('should create a team successfully', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });

      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league,
        teams: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.team.create as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 3 });
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(headCoachRole);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue(
        createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id })
      );
      // Final findUnique to return the complete team
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ userId: coach.id, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        roles: [headCoachRole],
        members: [],
      });

      const result = await TeamService.createTeam(
        { name: team.name, seasonId: season.id },
        coach.id
      );

      expect(result).toHaveProperty('id', team.id);
      expect(result).toHaveProperty('name', team.name);
      // Team, roles and the Head Coach staff row are written in one transaction
      // behind a row lock on the user (audit #49 / #70).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockPrisma.team.create).toHaveBeenCalled();
      expect(mockPrisma.teamRole.createMany).toHaveBeenCalled();
      expect(mockPrisma.teamStaff.create).toHaveBeenCalled();
    });

    describe('FREE-tier cap inside the transaction (audit #49)', () => {
      type Subscription = { subscriptionTier?: 'FREE' | 'PREMIUM' | 'LEAGUE'; subscriptionExpiresAt?: Date | null };

      function mockCreatePath(subscription: Subscription): { coach: { id: string }; season: { id: string } } {
        const coach = {
          ...createCoach(),
          subscriptionTier: 'FREE',
          subscriptionExpiresAt: null,
          ...subscription,
        };
        const league = createLeague();
        const season = createSeason({ leagueId: league.id });
        const team = createTeam({ seasonId: season.id });
        const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });
        (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ ...season, league, teams: [] });
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
        (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
        (mockPrisma.team.create as jest.Mock).mockResolvedValue(team);
        (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 3 });
        (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(headCoachRole);
        (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue(
          createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id })
        );
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ ...team, staff: [], roles: [], members: [] });
        return { coach, season };
      }

      it('throws PaymentRequiredError and creates nothing when a FREE user is at the cap', async () => {
        const { coach, season } = mockCreatePath({});
        // The recount happens inside the transaction, after the lock: a
        // concurrent create that committed first is visible here.
        (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(3);

        try {
          await TeamService.createTeam({ name: 'Fourth', seasonId: season.id }, coach.id);
          fail('expected to throw');
        } catch (err) {
          const e = err as Error & { statusCode?: number; details?: Record<string, string> };
          expect(e.statusCode).toBe(402);
          expect(e.details).toEqual({
            feature: 'unlimited_teams',
            currentTier: 'FREE',
            requiredTier: 'PREMIUM',
          });
        }
        expect(mockPrisma.$queryRaw).toHaveBeenCalled();
        expect(mockPrisma.team.create).not.toHaveBeenCalled();
        expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
      });

      it('allows a FREE user under the cap', async () => {
        const { coach, season } = mockCreatePath({});
        (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(2);

        await expect(
          TeamService.createTeam({ name: 'Third', seasonId: season.id }, coach.id)
        ).resolves.toBeDefined();
        expect(mockPrisma.team.create).toHaveBeenCalled();
      });

      it('treats an expired PREMIUM subscription as FREE', async () => {
        const { coach, season } = mockCreatePath({
          subscriptionTier: 'PREMIUM',
          subscriptionExpiresAt: new Date('2000-01-01'),
        });
        (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(3);

        await expect(
          TeamService.createTeam({ name: 'Fourth', seasonId: season.id }, coach.id)
        ).rejects.toMatchObject({ statusCode: 402 });
      });

      it('skips the count for unlimited tiers', async () => {
        const { coach, season } = mockCreatePath({
          subscriptionTier: 'PREMIUM',
          subscriptionExpiresAt: new Date('2999-01-01'),
        });

        await expect(
          TeamService.createTeam({ name: 'Tenth', seasonId: season.id }, coach.id)
        ).resolves.toBeDefined();
        expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
      });

      it('skips the cap for system admins', async () => {
        const admin = { ...createAdmin(), subscriptionTier: 'FREE', subscriptionExpiresAt: null };
        const league = createLeague();
        const season = createSeason({ leagueId: league.id });
        const team = createTeam({ seasonId: season.id });
        const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });
        (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ ...season, league, teams: [] });
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
        (mockPrisma.team.create as jest.Mock).mockResolvedValue(team);
        (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 3 });
        (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(headCoachRole);
        (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue(
          createTeamStaff({ teamId: team.id, userId: admin.id, roleId: headCoachRole.id })
        );
        (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ ...team, staff: [], roles: [], members: [] });

        await expect(
          TeamService.createTeam({ name: 'Admin team', seasonId: season.id }, admin.id)
        ).resolves.toBeDefined();
        expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
      });
    });

    it('should throw NotFoundError if season does not exist', async () => {
      const coach = createCoach();
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        TeamService.createTeam({ name: 'Test Team', seasonId: 'non-existent' }, coach.id)
      ).rejects.toThrow();

      try {
        await TeamService.createTeam({ name: 'Test Team', seasonId: 'non-existent' }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Season not found');
      }
    });

    it('should throw ForbiddenError if user does not exist or is not a coach', async () => {
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });

      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league,
        teams: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.createTeam({ name: 'Test Team', seasonId: season.id }, 'non-existent');
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to create teams in this league');
      }
    });
  });

  describe('getTeamById', () => {
    it('should return team for staff member', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { ...coachStaff, role: headCoachRole },
      ]);

      const result = await TeamService.getTeamById(team.id, coach.id);

      expect(result).toHaveProperty('id', team.id);
      expect(mockPrisma.team.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
        })
      );
    });

    it('should keep member emails for staff with canManageRoster', async () => {
      const { team, coach, season, league, members, headCoachRole, coachStaff } = createFullTeam({ memberCount: 1 });
      const player = members[0].player;

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [{ playerId: player.id, player: { id: player.id, name: player.name, email: player.email } }],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { ...coachStaff, role: headCoachRole },
      ]);

      const result = await TeamService.getTeamById(team.id, coach.id);

      expect(result.members[0].player).toEqual({ id: player.id, name: player.name, email: player.email });
    });

    it('should strip member emails for staff without canManageRoster (e.g. Team Manager)', async () => {
      const { team, coach, season, league, members, headCoachRole, coachStaff } = createFullTeam({ memberCount: 2 });
      const managerRole = createTeamRole({
        teamId: team.id,
        type: 'TEAM_MANAGER',
        name: 'Team Manager',
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: true,
        canViewStats: true,
      });
      const manager = createCoach();
      const managerStaff = createTeamStaff({ teamId: team.id, userId: manager.id, roleId: managerRole.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: members.map(({ member, player }) => ({
          ...member,
          player: { id: player.id, name: player.name, email: player.email },
        })),
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(manager);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(managerStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { ...managerStaff, role: managerRole },
      ]);

      const result = await TeamService.getTeamById(team.id, manager.id);

      expect(result.members).toHaveLength(2);
      for (const m of result.members) {
        expect(m.player).not.toHaveProperty('email');
        expect(m.player.id).toBeDefined();
        expect(m.player.name).toBeDefined();
      }
      // jersey etc. preserved
      expect(result.members[0]).toHaveProperty('jerseyNumber', members[0].member.jerseyNumber);
    });

    it('should return team for team member', async () => {
      const { team, coach, season, league, members, headCoachRole, coachStaff } = createFullTeam({ memberCount: 1 });
      const player = members[0].player;

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [{ playerId: player.id, player: { id: player.id, name: player.name, email: player.email } }],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(members[0].member);

      const result = await TeamService.getTeamById(team.id, player.id);

      expect(result).toHaveProperty('id', team.id);
      // Roster players do not get teammate emails (audit #80)
      expect(result.members[0].player).toEqual({ id: player.id, name: player.name });
      expect(result.members[0].player).not.toHaveProperty('email');
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.getTeamById('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      // Mock canAccessTeam dependencies
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await TeamService.getTeamById(team.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this team');
      }
    });
  });

  describe('listTeams', () => {
    const accessClause = (userId: string): Record<string, unknown> => ({
      OR: [
        { staff: { some: { userId } } },
        { members: { some: { playerId: userId } } },
        { season: { league: { admins: { some: { userId } } } } },
      ],
    });

    it('should return teams the user has access to', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
      }]);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);

      const result = await TeamService.listTeams({ limit: 10, offset: 0 }, coach.id);

      expect(result.teams).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockPrisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [accessClause(coach.id)] } })
      );
    });

    it('should return empty result if user has no teams', async () => {
      const user = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);

      const result = await TeamService.listTeams({ limit: 10, offset: 0 }, user.id);

      expect(result.teams).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should AND the access filter with seasonId (audit #11)', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
      }]);

      const result = await TeamService.listTeams(
        { seasonId: season.id, limit: 10, offset: 0 },
        coach.id
      );

      expect(result.teams).toHaveLength(1);
      expect(mockPrisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ seasonId: season.id }, accessClause(coach.id)] },
        })
      );
      expect(mockPrisma.team.count).toHaveBeenCalledWith({
        where: { AND: [{ seasonId: season.id }, accessClause(coach.id)] },
      });
    });

    it('should AND the access filter with leagueId and playerId', async () => {
      const user = createPlayer();
      const other = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);

      await TeamService.listTeams(
        { leagueId: 'downtown-youth-league', playerId: other.id, limit: 10, offset: 0 },
        user.id
      );

      expect(mockPrisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { season: { leagueId: 'downtown-youth-league' } },
              { members: { some: { playerId: other.id } } },
              accessClause(user.id),
            ],
          },
        })
      );
    });

    it('should not apply the access filter for system admins', async () => {
      const admin = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);

      await TeamService.listTeams({ leagueId: 'downtown-youth-league', limit: 10, offset: 0 }, admin.id);

      expect(mockPrisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ season: { leagueId: 'downtown-youth-league' } }] },
        })
      );
    });

    it('should use an empty where for system admins with no filters', async () => {
      const admin = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);

      await TeamService.listTeams({ limit: 10, offset: 0 }, admin.id);

      expect(mockPrisma.team.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });
  });

  describe('updateTeam', () => {
    it('should update team name when user has canManageTeam permission', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();
      const newName = 'Updated Team Name';

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.update as jest.Mock).mockResolvedValue({
        ...team,
        name: newName,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
      });

      const result = await TeamService.updateTeam(team.id, { name: newName }, coach.id);

      expect(result).toHaveProperty('name', newName);
      expect(mockPrisma.team.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
          data: expect.objectContaining({ name: newName }),
        })
      );
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeam('non-existent', { name: 'New Name' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageTeam permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.updateTeam(team.id, { name: 'New Name' }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to update this team');
      }
    });

    it('should throw NotFoundError if updating to non-existent season', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeam(team.id, { seasonId: 'non-existent' }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Season not found');
      }
    });

    it('should throw ForbiddenError when a coach moves the team into a league they do not administer (audit #13)', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const otherLeague = createLeague();
      const otherSeason = createSeason({ leagueId: otherLeague.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(otherSeason);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.updateTeam(
        team.id,
        { seasonId: otherSeason.id },
        coach.id
      ).catch((e) => e);

      expectForbiddenError(error, 'You do not have permission to move this team into that season');
      expect(mockPrisma.leagueAdmin.findUnique).toHaveBeenCalledWith({
        where: { leagueId_userId: { leagueId: otherLeague.id, userId: coach.id } },
      });
      expect(mockPrisma.team.update).not.toHaveBeenCalled();
    });

    it('should allow moving the team when the caller administers the target league', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();
      const otherLeague = createLeague();
      const otherSeason = createSeason({ leagueId: otherLeague.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(otherSeason);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({
        leagueId: otherLeague.id,
        userId: coach.id,
      });
      (mockPrisma.team.update as jest.Mock).mockResolvedValue({
        ...team,
        seasonId: otherSeason.id,
        season: { ...season, league },
        staff: [],
        members: [],
      });

      const result = await TeamService.updateTeam(team.id, { seasonId: otherSeason.id }, coach.id);

      expect(result.seasonId).toBe(otherSeason.id);
      expect(mockPrisma.team.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ seasonId: otherSeason.id }) })
      );
    });

    it('should not check league admin when seasonId is unchanged', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.update as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [],
        members: [],
      });

      await TeamService.updateTeam(team.id, { seasonId: team.seasonId }, coach.id);

      expect(mockPrisma.season.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.leagueAdmin.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteTeam', () => {
    it('should delete team successfully when user has canManageTeam permission', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.delete as jest.Mock).mockResolvedValue(team);

      const result = await TeamService.deleteTeam(team.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.team.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
        })
      );
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.deleteTeam('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageTeam permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.deleteTeam(team.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to delete this team');
      }
    });
  });

  describe('addPlayer', () => {
    it('should add player to team successfully', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.create as jest.Mock).mockResolvedValue({
        ...member,
        player: { id: player.id, name: player.name, email: player.email },
        team: { id: team.id, name: team.name },
      });

      const result = await TeamService.addPlayer(
        team.id,
        { playerId: player.id, jerseyNumber: 10, position: 'Guard' },
        coach.id
      );

      expect(result).toHaveProperty('playerId', player.id);
      expect(mockPrisma.teamMember.create).toHaveBeenCalled();
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addPlayer('non-existent', { playerId: 'player-id' }, 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.addPlayer(team.id, { playerId: 'player-id' }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to add players to this team');
      }
    });

    it('should throw NotFoundError if player does not exist', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(null);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);

      try {
        await TeamService.addPlayer(team.id, { playerId: 'non-existent' }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw BadRequestError if player is already on team', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const existingMember = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(existingMember);

      try {
        await TeamService.addPlayer(team.id, { playerId: player.id }, coach.id);
      } catch (error) {
        expectBadRequestError(error, 'Player is already on this team');
      }
    });
  });

  describe('removePlayer', () => {
    it('should remove player from team successfully', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);
      (mockPrisma.teamMember.delete as jest.Mock).mockResolvedValue(member);

      const result = await TeamService.removePlayer(team.id, player.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.teamMember.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removePlayer('non-existent', 'player-id', 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.removePlayer(team.id, 'player-id', otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to remove players from this team');
      }
    });

    it('should throw NotFoundError if player is not on team', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removePlayer(team.id, 'non-existent-player', coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player is not on this team');
      }
    });
  });

  describe('updateTeamMember', () => {
    it('should update team member successfully', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const member = createTeamMember({ teamId: team.id, playerId: player.id, jerseyNumber: 10 });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);
      (mockPrisma.teamMember.update as jest.Mock).mockResolvedValue({
        ...member,
        jerseyNumber: 23,
        position: 'Forward',
        player: { id: player.id, name: player.name, email: player.email },
        team: { id: team.id, name: team.name },
      });

      const result = await TeamService.updateTeamMember(
        team.id,
        player.id,
        { jerseyNumber: 23, position: 'Forward' },
        coach.id
      );

      expect(result).toHaveProperty('jerseyNumber', 23);
      expect(result).toHaveProperty('position', 'Forward');
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeamMember('non-existent', 'player-id', { jerseyNumber: 10 }, 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.updateTeamMember(team.id, 'player-id', { jerseyNumber: 10 }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to update team members');
      }
    });

    it('should throw NotFoundError if player is not on team', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeamMember(team.id, 'non-existent', { jerseyNumber: 10 }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player is not on this team');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Staff management (addStaffMember / removeStaffMember)
  //
  // hasTeamPermission fans out: user.findUnique (system admin?) →
  // team.findUnique (league admin?) → teamStaff.findMany (roles) →
  // teamMember.findUnique (member-as-player fallback). We set the first check
  // to ADMIN so the permission short-circuits; that keeps these focused on
  // the staff-management logic rather than re-testing permissions.
  // --------------------------------------------------------------------------
  describe('addStaffMember', () => {
    it('adds a staff member with the requested role and returns it with user+role included', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH', name: 'Assistant Coach' });
      const created = createTeamStaff({ teamId: team.id, userId: targetUser.id, roleId: role.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === admin.id) return Promise.resolve(admin);
        if (where.id === targetUser.id) return Promise.resolve(targetUser);
        return Promise.resolve(null);
      });
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({
        ...created,
        user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
        role,
      });

      const result = await TeamService.addStaffMember(
        team.id,
        targetUser.id,
        'Assistant Coach',
        admin.id
      );

      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith({
        data: { teamId: team.id, userId: targetUser.id, roleId: role.id },
        include: expect.objectContaining({ user: expect.any(Object), role: true }),
      });
      expect(result).toMatchObject({
        teamId: team.id,
        userId: targetUser.id,
        roleId: role.id,
        role: expect.objectContaining({ name: 'Assistant Coach' }),
      });
    });

    it('throws NotFoundError when team does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addStaffMember('missing-team', 'u-1', 'Head Coach', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when requester lacks canManageTeam', async () => {
      const { team } = createFullTeam();
      const nonStaff = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(nonStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addStaffMember(team.id, 'u-1', 'Head Coach', nonStaff.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have permission to manage team staff');
      }
    });

    it('throws NotFoundError when target user does not exist', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === admin.id) return Promise.resolve(admin);
        return Promise.resolve(null);
      });

      try {
        await TeamService.addStaffMember(team.id, 'missing-user', 'Head Coach', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'User not found');
      }
    });

    it('throws NotFoundError when the named role does not exist on this team', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === admin.id) return Promise.resolve(admin);
        if (where.id === targetUser.id) return Promise.resolve(targetUser);
        return Promise.resolve(null);
      });
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addStaffMember(team.id, targetUser.id, 'Nonexistent', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Role "Nonexistent" not found for this team');
      }
    });

    it('throws BadRequestError when the user already holds that role', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });
      const existing = createTeamStaff({ teamId: team.id, userId: targetUser.id, roleId: role.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === admin.id) return Promise.resolve(admin);
        if (where.id === targetUser.id) return Promise.resolve(targetUser);
        return Promise.resolve(null);
      });
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.findUnique as jest.Mock).mockResolvedValue(existing);

      try {
        await TeamService.addStaffMember(team.id, targetUser.id, 'Head Coach', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'User already has this role on the team');
      }
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });
  });

  describe('removeStaffMember', () => {
    it('removes staff when role is not HEAD_COACH (skips last-head-coach guard)', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const role = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH', name: 'Assistant Coach' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.delete as jest.Mock).mockResolvedValue({});

      const result = await TeamService.removeStaffMember(team.id, 'u-1', 'Assistant Coach', admin.id);

      expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
      expect(mockPrisma.teamStaff.delete).toHaveBeenCalledWith({
        where: {
          teamId_userId_roleId: { teamId: team.id, userId: 'u-1', roleId: role.id },
        },
      });
      expect(result).toEqual({ success: true });
    });

    it('blocks removing the last HEAD_COACH with a BadRequestError', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const role = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(1);

      try {
        await TeamService.removeStaffMember(team.id, 'u-1', 'Head Coach', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(
          err,
          'Cannot remove the last Head Coach. Assign another Head Coach first.'
        );
      }
      expect(mockPrisma.teamStaff.delete).not.toHaveBeenCalled();
    });

    it('allows removing a HEAD_COACH when another head coach remains', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const role = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.teamStaff.delete as jest.Mock).mockResolvedValue({});

      const result = await TeamService.removeStaffMember(team.id, 'u-1', 'Head Coach', admin.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.teamStaff.delete).toHaveBeenCalled();
    });

    it('throws NotFoundError when team does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removeStaffMember('missing', 'u-1', 'Head Coach', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
    });

    it('throws ForbiddenError when requester lacks canManageTeam', async () => {
      const { team } = createFullTeam();
      const nonStaff = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(nonStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removeStaffMember(team.id, 'u-1', 'Head Coach', nonStaff.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have permission to manage team staff');
      }
    });

    it('throws NotFoundError when the named role does not exist on this team', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removeStaffMember(team.id, 'u-1', 'Ghost', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Role "Ghost" not found for this team');
      }
    });
  });

  describe('createCustomRole', () => {
    it('creates a CUSTOM role with defaults: canViewStats=true, others=false', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamRole.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ id: 'role-new', ...data })
      );

      const result = await TeamService.createCustomRole(
        team.id,
        { name: 'Scorekeeper' },
        admin.id
      );

      expect(mockPrisma.teamRole.create).toHaveBeenCalledWith({
        data: {
          teamId: team.id,
          type: 'CUSTOM',
          name: 'Scorekeeper',
          description: undefined,
          canManageTeam: false,
          canManageRoster: false,
          canTrackStats: false,
          canViewStats: true,
          canShareStats: false,
        },
      });
      expect(result).toMatchObject({
        name: 'Scorekeeper',
        type: 'CUSTOM',
        canViewStats: true,
        canManageTeam: false,
      });
    });

    it('honors caller-supplied permission flags and description', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamRole.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ id: 'role-new', ...data })
      );

      await TeamService.createCustomRole(
        team.id,
        {
          name: 'Stats Lead',
          description: 'Runs the scorebook',
          canTrackStats: true,
          canShareStats: true,
          canViewStats: false,
        },
        admin.id
      );

      expect(mockPrisma.teamRole.create).toHaveBeenCalledWith({
        data: {
          teamId: team.id,
          type: 'CUSTOM',
          name: 'Stats Lead',
          description: 'Runs the scorebook',
          canManageTeam: false,
          canManageRoster: false,
          canTrackStats: true,
          canViewStats: false,
          canShareStats: true,
        },
      });
    });

    it('throws NotFoundError when team does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.createCustomRole('missing', { name: 'X' }, admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
    });

    it('throws ForbiddenError when requester lacks canManageTeam', async () => {
      const { team } = createFullTeam();
      const nonStaff = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(nonStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.createCustomRole(team.id, { name: 'X' }, nonStaff.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have permission to create team roles');
      }
      expect(mockPrisma.teamRole.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestError when a role with the given name already exists', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const existing = createTeamRole({ teamId: team.id, name: 'Scorekeeper' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(existing);

      try {
        await TeamService.createCustomRole(team.id, { name: 'Scorekeeper' }, admin.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'A role with this name already exists');
      }
      expect(mockPrisma.teamRole.create).not.toHaveBeenCalled();
    });
  });

  describe('getTeamRoles', () => {
    it('returns all roles for a team (ordered by type, then name) when user has access', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const roles = [
        createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' }),
        createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH', name: 'Assistant Coach' }),
      ].map(r => ({ ...r, staff: [] }));

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findMany as jest.Mock).mockResolvedValue(roles);

      const result = await TeamService.getTeamRoles(team.id, admin.id);

      expect(mockPrisma.teamRole.findMany).toHaveBeenCalledWith({
        where: { teamId: team.id },
        include: expect.objectContaining({ staff: expect.any(Object) }),
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      });
      expect(result).toHaveLength(2);
    });

    it('throws ForbiddenError when user has no access to the team', async () => {
      const { team } = createFullTeam();
      const outsider = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(outsider);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.getTeamRoles(team.id, outsider.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have access to this team');
      }
      expect(mockPrisma.teamRole.findMany).not.toHaveBeenCalled();
    });
  });

  describe('addManagedPlayer', () => {
    it('creates a managed user and links them to the team with jersey + position', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const managedUser = {
        id: 'managed-1',
        name: 'Junior Smith',
        email: null,
        isManaged: true,
        managedById: admin.id,
      };
      const teamMember = {
        id: 'tm-1',
        teamId: team.id,
        playerId: managedUser.id,
        jerseyNumber: 7,
        position: 'PG',
        player: {
          id: managedUser.id,
          name: managedUser.name,
          email: null,
          isManaged: true,
          managedById: admin.id,
        },
        team: { id: team.id, name: team.name },
      };

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(managedUser);
      (mockPrisma.teamMember.create as jest.Mock).mockResolvedValue(teamMember);

      const result = await TeamService.addManagedPlayer(
        team.id,
        { name: 'Junior Smith', jerseyNumber: 7, position: 'PG' },
        admin.id
      );

      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Junior Smith',
          role: 'PLAYER',
          isManaged: true,
          managedById: admin.id,
          email: null,
        }),
      });
      expect(mockPrisma.teamMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teamId: team.id,
            playerId: managedUser.id,
            jerseyNumber: 7,
            position: 'PG',
          }),
        })
      );
      expect(result).toMatchObject({ playerId: managedUser.id, jerseyNumber: 7 });
    });

    it('throws NotFoundError when team does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addManagedPlayer('missing', { name: 'X' }, admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Team not found');
      }
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when requester lacks canManageRoster', async () => {
      const { team } = createFullTeam();
      const nonStaff = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(nonStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addManagedPlayer(team.id, { name: 'X' }, nonStaff.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, "You do not have permission to manage this team's roster");
      }
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });
  });
});
