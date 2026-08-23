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

/** Distinct-team rows as returned by `countDistinctStaffTeams` (audit B2.8). */
function staffTeams(n: number): Array<{ teamId: string }> {
  return Array.from({ length: n }, (_, i) => ({ teamId: `team-${i}` }));
}

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
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
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
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(3));

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
        // Cap counts DISTINCT teams, not staff rows (audit B2.8).
        expect(mockPrisma.teamStaff.findMany).toHaveBeenCalledWith({
          where: { userId: coach.id },
          distinct: ['teamId'],
          select: { teamId: true },
        });
      });

      it('allows a FREE user under the cap', async () => {
        const { coach, season } = mockCreatePath({});
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(2));

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
        (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(3));

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
        expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
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
        expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
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

    it('should throw ForbiddenError if user is not head coach / league admin / ADMIN', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);

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
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
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
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
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
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
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

    it('should throw ForbiddenError when an ASSISTANT coach moves the team (B2.3)', async () => {
      const { team } = createFullTeam();
      const assistant = createCoach();
      const assistantRole = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH' });
      const assistantStaff = createTeamStaff({ teamId: team.id, userId: assistant.id, roleId: assistantRole.id });
      const otherSeason = createSeason();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(assistant);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...assistantStaff, role: assistantRole }]);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null); // no HEAD_COACH row

      const error = await TeamService.updateTeam(team.id, { seasonId: otherSeason.id }, assistant.id).catch((e) => e);

      expectForbiddenError(error, 'Only a head coach can move this team to another season');
      expect(mockPrisma.season.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.team.update).not.toHaveBeenCalled();
    });

    it('should still allow an assistant coach to rename the team', async () => {
      const { team, season, league } = createFullTeam();
      const assistant = createCoach();
      const assistantRole = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH' });
      const assistantStaff = createTeamStaff({ teamId: team.id, userId: assistant.id, roleId: assistantRole.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(assistant);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...assistantStaff, role: assistantRole }]);
      (mockPrisma.team.update as jest.Mock).mockResolvedValue({
        ...team, name: 'Renamed', season: { ...season, league }, staff: [], members: [],
      });

      const result = await TeamService.updateTeam(team.id, { name: 'Renamed' }, assistant.id);

      expect(result.name).toBe('Renamed');
      expect(mockPrisma.teamStaff.findFirst).not.toHaveBeenCalled();
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
    it('should delete team successfully when user is the head coach', async () => {
      const { team, coach, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.team.delete as jest.Mock).mockResolvedValue(team);

      const result = await TeamService.deleteTeam(team.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.team.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
        })
      );
      expect(mockPrisma.teamStaff.findFirst).toHaveBeenCalledWith({
        where: { teamId: team.id, userId: coach.id, role: { type: 'HEAD_COACH' } },
        select: { id: true },
      });
    });

    it('should throw ForbiddenError when an ASSISTANT coach deletes the team (B2.3)', async () => {
      const { team } = createFullTeam();
      const assistant = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(assistant);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null); // no HEAD_COACH row

      const error = await TeamService.deleteTeam(team.id, assistant.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have permission to delete this team');
      expect(mockPrisma.team.delete).not.toHaveBeenCalled();
    });

    it('should allow a system admin to delete the team', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.team.delete as jest.Mock).mockResolvedValue(team);

      await expect(TeamService.deleteTeam(team.id, admin.id)).resolves.toEqual({ success: true });
      expect(mockPrisma.teamStaff.findFirst).not.toHaveBeenCalled();
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
  // Staff management (listStaff / addStaffMember / changeStaffRole /
  // removeStaffMember / getTeamRoles)
  //
  // canManageStaff fans out: user.findUnique (system admin?) →
  // team.findUnique (league of team) → leagueAdmin.findUnique →
  // teamStaff.findFirst (HEAD_COACH row?). Helpers below set up the three
  // caller profiles the role matrix cares about (B2.3 / B2.7).
  // --------------------------------------------------------------------------

  /** Requester is a system ADMIN: canManageStaff short-circuits. */
  function mockAdminRequester(admin: ReturnType<typeof createAdmin>): void {
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where.id === admin.id ? admin : null)
    );
  }

  /** Requester is non-admin staff whose single role row has `roleType`. */
  function mockStaffRequester(
    requester: ReturnType<typeof createCoach>,
    roleType: 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER'
  ): void {
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where.id === requester.id ? requester : null)
    );
    (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
    // isHeadCoach filters on role.type = HEAD_COACH; emulate that filter here.
    (mockPrisma.teamStaff.findFirst as jest.Mock).mockImplementation(({ where }) => {
      if (where.role?.type === 'HEAD_COACH') {
        return Promise.resolve(
          roleType === 'HEAD_COACH' && where.userId === requester.id
            ? { id: 'staff-row' }
            : null
        );
      }
      return Promise.resolve(null);
    });
  }

  describe('listStaff', () => {
    it('returns staff with user + role (emails included) for a roster manager', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const rows = [
        { ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email, isManaged: false }, role: headCoachRole },
      ];

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockImplementation(({ include }) =>
        Promise.resolve(include?.user ? rows : [{ ...coachStaff, role: headCoachRole }])
      );

      const result = await TeamService.listStaff(team.id, coach.id);

      expect(result).toHaveLength(1);
      expect(result[0].user).toEqual(expect.objectContaining({ email: coach.email }));
      expect(result[0].role).toEqual(expect.objectContaining({ type: 'HEAD_COACH' }));
    });

    it('strips emails for a caller without canManageRoster (team manager)', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const manager = createCoach();
      const managerRole = createTeamRole({ teamId: team.id, type: 'TEAM_MANAGER' });
      const managerStaff = createTeamStaff({ teamId: team.id, userId: manager.id, roleId: managerRole.id });
      const rows = [
        { ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email, isManaged: false }, role: headCoachRole },
        { ...managerStaff, user: { id: manager.id, name: manager.name, email: manager.email, isManaged: false }, role: managerRole },
      ];

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(manager);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(managerStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockImplementation(({ include }) =>
        Promise.resolve(include?.user ? rows : [{ ...managerStaff, role: managerRole }])
      );

      const result = await TeamService.listStaff(team.id, manager.id);

      expect(result).toHaveLength(2);
      for (const row of result) {
        expect(row.user).not.toHaveProperty('email');
        expect(row.user).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
      }
    });

    it('throws NotFoundError when the team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.listStaff('missing', 'u-1').catch((e) => e);

      expectNotFoundError(error, 'Team not found');
    });

    it('throws ForbiddenError for an outsider', async () => {
      const { team } = createFullTeam();
      const outsider = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ ...team, season: { league: { admins: [] } } });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(outsider);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.listStaff(team.id, outsider.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have access to this team');
      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
    });
  });

  describe('addStaffMember', () => {
    it('adds staff by userId as a head coach and returns the row with user+role', async () => {
      const { team, coach } = createFullTeam();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH', name: 'Assistant Coach' });
      const created = createTeamStaff({ teamId: team.id, userId: targetUser.id, roleId: role.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockStaffRequester(coach, 'HEAD_COACH');
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === coach.id) return Promise.resolve(coach);
        if (where.id === targetUser.id) return Promise.resolve({ id: targetUser.id, name: targetUser.name });
        return Promise.resolve(null);
      });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({
        ...created,
        user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
        role,
      });
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([]);

      const result = await TeamService.addStaffMember(
        team.id,
        { userId: targetUser.id, roleType: 'ASSISTANT_COACH' },
        coach.id
      );

      expect(mockPrisma.teamRole.findFirst).toHaveBeenCalledWith({
        where: { teamId: team.id, type: 'ASSISTANT_COACH' },
      });
      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith({
        data: { teamId: team.id, userId: targetUser.id, roleId: role.id },
        include: expect.objectContaining({ user: expect.any(Object), role: true }),
      });
      expect(result).toMatchObject({
        teamId: team.id,
        userId: targetUser.id,
        role: expect.objectContaining({ name: 'Assistant Coach' }),
      });
      // Added user is notified (best effort).
      expect(mockPrisma.pushToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { in: [targetUser.id] } } })
      );
    });

    it('adds staff by email (case-insensitive lookup of an EXISTING user) as a system admin', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'TEAM_MANAGER' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: targetUser.id, name: targetUser.name });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({
        ...createTeamStaff({ teamId: team.id, userId: targetUser.id, roleId: role.id }),
        user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
        role,
      });
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([]);

      const result = await TeamService.addStaffMember(
        team.id,
        { email: targetUser.email!.toUpperCase(), roleType: 'TEAM_MANAGER' },
        admin.id
      );

      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: targetUser.email!.toUpperCase(), mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(result.userId).toBe(targetUser.id);
    });

    it('does not fail the request when the notification send throws', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'TEAM_MANAGER' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: targetUser.id, name: targetUser.name });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({ id: 's', userId: targetUser.id, role });
      (mockPrisma.pushToken.findMany as jest.Mock).mockRejectedValue(new Error('expo down'));

      await expect(
        TeamService.addStaffMember(team.id, { email: targetUser.email!, roleType: 'TEAM_MANAGER' }, admin.id)
      ).resolves.toMatchObject({ userId: targetUser.id });
    });

    it('throws NotFoundError when team does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService
        .addStaffMember('missing-team', { userId: 'u-1', roleType: 'HEAD_COACH' }, admin.id)
        .catch((e) => e);

      expectNotFoundError(error, 'Team not found');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when the requester is an ASSISTANT coach (B2.3)', async () => {
      const { team } = createFullTeam();
      const assistant = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockStaffRequester(assistant, 'ASSISTANT_COACH');

      const error = await TeamService
        .addStaffMember(team.id, { userId: 'u-1', roleType: 'TEAM_MANAGER' }, assistant.id)
        .catch((e) => e);

      expectForbiddenError(error, 'You do not have permission to manage team staff');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('allows a league admin of the team\'s league', async () => {
      const { team, league, season } = createFullTeam();
      const leagueAdmin = createCoach();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH' });

      (mockPrisma.team.findUnique as jest.Mock).mockImplementation(({ select }) =>
        Promise.resolve(select?.season ? { season: { leagueId: league.id } } : { ...team, seasonId: season.id })
      );
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === leagueAdmin.id) return Promise.resolve(leagueAdmin);
        if (where.id === targetUser.id) return Promise.resolve({ id: targetUser.id, name: targetUser.name });
        return Promise.resolve(null);
      });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({ leagueId: league.id, userId: leagueAdmin.id });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({ id: 's', userId: targetUser.id, role });
      (mockPrisma.pushToken.findMany as jest.Mock).mockResolvedValue([]);

      await expect(
        TeamService.addStaffMember(team.id, { userId: targetUser.id, roleType: 'ASSISTANT_COACH' }, leagueAdmin.id)
      ).resolves.toMatchObject({ userId: targetUser.id });
      expect(mockPrisma.leagueAdmin.findUnique).toHaveBeenCalledWith({
        where: { leagueId_userId: { leagueId: league.id, userId: leagueAdmin.id } },
      });
    });

    it('throws NotFoundError when target user does not exist (never creates users)', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      const error = await TeamService
        .addStaffMember(team.id, { email: 'nobody@example.com', roleType: 'HEAD_COACH' }, admin.id)
        .catch((e) => e);

      expectNotFoundError(error, 'User not found');
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the role type does not exist on this team', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === admin.id) return Promise.resolve(admin);
        if (where.id === targetUser.id) return Promise.resolve({ id: targetUser.id, name: targetUser.name });
        return Promise.resolve(null);
      });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(null);

      const error = await TeamService
        .addStaffMember(team.id, { userId: targetUser.id, roleType: 'TEAM_MANAGER' }, admin.id)
        .catch((e) => e);

      expectNotFoundError(error, 'Role "TEAM_MANAGER" not found for this team');
    });

    it('throws BadRequestError when the user is already staff on the team', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const targetUser = createCoach();
      const role = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
        if (where.id === admin.id) return Promise.resolve(admin);
        if (where.id === targetUser.id) return Promise.resolve({ id: targetUser.id, name: targetUser.name });
        return Promise.resolve(null);
      });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(role);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(
        createTeamStaff({ teamId: team.id, userId: targetUser.id })
      );

      const error = await TeamService
        .addStaffMember(team.id, { userId: targetUser.id, roleType: 'HEAD_COACH' }, admin.id)
        .catch((e) => e);

      expectBadRequestError(error, 'User is already a staff member of this team');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });
  });

  describe('changeStaffRole', () => {
    it('updates the staff row to the new role', async () => {
      const { team, coach } = createFullTeam();
      const target = createCoach();
      const assistantRole = createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH' });
      const managerRole = createTeamRole({ teamId: team.id, type: 'TEAM_MANAGER' });
      const current = createTeamStaff({ teamId: team.id, userId: target.id, roleId: assistantRole.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockStaffRequester(coach, 'HEAD_COACH');
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockImplementation(({ where }) => {
        if (where.role?.type === 'HEAD_COACH') return Promise.resolve({ id: 'hc-row' });
        return Promise.resolve({ ...current, role: assistantRole });
      });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(managerRole);
      (mockPrisma.teamStaff.update as jest.Mock).mockResolvedValue({ ...current, roleId: managerRole.id, role: managerRole });

      const result = await TeamService.changeStaffRole(team.id, target.id, 'TEAM_MANAGER', coach.id);

      expect(mockPrisma.teamStaff.update).toHaveBeenCalledWith({
        where: { id: current.id },
        data: { roleId: managerRole.id },
        include: expect.objectContaining({ role: true }),
      });
      expect(result.role).toEqual(expect.objectContaining({ type: 'TEAM_MANAGER' }));
    });

    it('throws NotFoundError when the team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.changeStaffRole('t', 'u', 'TEAM_MANAGER', 'r').catch((e) => e);

      expectNotFoundError(error, 'Team not found');
    });

    it('throws ForbiddenError for an assistant coach', async () => {
      const { team } = createFullTeam();
      const assistant = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockStaffRequester(assistant, 'ASSISTANT_COACH');

      const error = await TeamService.changeStaffRole(team.id, 'u', 'TEAM_MANAGER', assistant.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have permission to manage team staff');
      expect(mockPrisma.teamStaff.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the target is not staff', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.changeStaffRole(team.id, 'u', 'TEAM_MANAGER', admin.id).catch((e) => e);

      expectNotFoundError(error, 'User is not a staff member of this team');
    });

    it('throws BadRequestError when the user already holds that role', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(headCoachRole);

      const error = await TeamService.changeStaffRole(team.id, coach.id, 'HEAD_COACH', admin.id).catch((e) => e);

      expectBadRequestError(error, 'User already has this role on the team');
    });

    it('refuses to demote the last head coach (400)', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const admin = createAdmin();
      const managerRole = createTeamRole({ teamId: team.id, type: 'TEAM_MANAGER' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(managerRole);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ userId: coach.id }]);

      const error = await TeamService.changeStaffRole(team.id, coach.id, 'TEAM_MANAGER', admin.id).catch((e) => e);

      expectBadRequestError(error, 'Cannot remove the last Head Coach. Assign another Head Coach first.');
      expect(mockPrisma.teamStaff.update).not.toHaveBeenCalled();
    });

    it('demotes a head coach when another head coach remains', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const admin = createAdmin();
      const managerRole = createTeamRole({ teamId: team.id, type: 'TEAM_MANAGER' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });
      (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue(managerRole);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ userId: coach.id }, { userId: 'other-hc' }]);
      (mockPrisma.teamStaff.update as jest.Mock).mockResolvedValue({ ...coachStaff, role: managerRole });

      await expect(
        TeamService.changeStaffRole(team.id, coach.id, 'TEAM_MANAGER', admin.id)
      ).resolves.toMatchObject({ role: expect.objectContaining({ type: 'TEAM_MANAGER' }) });
    });
  });

  describe('removeStaffMember', () => {
    it('removes a non-head-coach staff member as a head coach', async () => {
      const { team, coach } = createFullTeam();
      const target = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockStaffRequester(coach, 'HEAD_COACH');
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockImplementation(({ where }) => {
        if (where.role?.type === 'HEAD_COACH') return Promise.resolve({ id: 'hc-row' });
        return Promise.resolve(createTeamStaff({ teamId: team.id, userId: target.id }));
      });
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ userId: coach.id }]);
      (mockPrisma.teamStaff.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await TeamService.removeStaffMember(team.id, target.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.teamStaff.deleteMany).toHaveBeenCalledWith({
        where: { teamId: team.id, userId: target.id },
      });
    });

    it('throws NotFoundError when the team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.removeStaffMember('t', 'u', 'r').catch((e) => e);

      expectNotFoundError(error, 'Team not found');
    });

    it('throws ForbiddenError when an assistant coach removes someone else', async () => {
      const { team, coach } = createFullTeam();
      const assistant = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockStaffRequester(assistant, 'ASSISTANT_COACH');

      const error = await TeamService.removeStaffMember(team.id, coach.id, assistant.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have permission to manage team staff');
      expect(mockPrisma.teamStaff.deleteMany).not.toHaveBeenCalled();
    });

    it('lets an assistant coach remove THEMSELVES without the manage-staff gate', async () => {
      const { team, coach } = createFullTeam();
      const assistant = createCoach();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(
        createTeamStaff({ teamId: team.id, userId: assistant.id })
      );
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ userId: coach.id }]);
      (mockPrisma.teamStaff.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await TeamService.removeStaffMember(team.id, assistant.id, assistant.id);

      expect(result).toEqual({ success: true });
      // No permission lookups at all on the self path.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.teamStaff.deleteMany).toHaveBeenCalledWith({
        where: { teamId: team.id, userId: assistant.id },
      });
    });

    it('throws NotFoundError when the target is not staff', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.removeStaffMember(team.id, 'u', admin.id).catch((e) => e);

      expectNotFoundError(error, 'User is not a staff member of this team');
      expect(mockPrisma.teamStaff.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses to remove the last head coach — even when they remove themselves (400)', async () => {
      const { team, coach, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ userId: coach.id }]);

      const error = await TeamService.removeStaffMember(team.id, coach.id, coach.id).catch((e) => e);

      expectBadRequestError(error, 'Cannot remove the last Head Coach. Assign another Head Coach first.');
      expect(mockPrisma.teamStaff.deleteMany).not.toHaveBeenCalled();
    });

    it('removes a head coach when another head coach remains', async () => {
      const { team, coach, coachStaff } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      mockAdminRequester(admin);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ userId: coach.id }, { userId: 'other-hc' }]);
      (mockPrisma.teamStaff.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(TeamService.removeStaffMember(team.id, coach.id, admin.id)).resolves.toEqual({ success: true });
    });
  });

  describe('createCustomRole', () => {
    it('creates a CUSTOM role with defaults applied to omitted flags', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamRole.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ id: 'role-1', ...data })
      );

      const result = await TeamService.createCustomRole(team.id, { name: 'Scorekeeper', canTrackStats: true }, admin.id);

      expect(mockPrisma.teamRole.create).toHaveBeenCalledWith({
        data: {
          teamId: team.id,
          type: 'CUSTOM',
          name: 'Scorekeeper',
          description: undefined,
          canManageTeam: false,
          canManageRoster: false,
          canTrackStats: true,
          canViewStats: true,
          canShareStats: false,
        },
      });
      expect(result).toMatchObject({ type: 'CUSTOM', name: 'Scorekeeper' });
    });

    it('throws NotFoundError when team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.createCustomRole('t', { name: 'X' }, 'u').catch((e) => e);

      expectNotFoundError(error, 'Team not found');
    });

    it('throws ForbiddenError when requester lacks canManageTeam', async () => {
      const { team } = createFullTeam();
      const nonStaff = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(nonStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await TeamService.createCustomRole(team.id, { name: 'X' }, nonStaff.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have permission to create team roles');
    });

    it('throws BadRequestError when the role name already exists', async () => {
      const { team, headCoachRole } = createFullTeam();
      const admin = createAdmin();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(headCoachRole);

      const error = await TeamService.createCustomRole(team.id, { name: 'Head Coach' }, admin.id).catch((e) => e);

      expectBadRequestError(error, 'A role with this name already exists');
      expect(mockPrisma.teamRole.create).not.toHaveBeenCalled();
    });
  });

  describe('getTeamRoles', () => {
    it('returns role definitions (ordered by type, then name) when user has access', async () => {
      const { team } = createFullTeam();
      const admin = createAdmin();
      const roles = [
        createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' }),
        createTeamRole({ teamId: team.id, type: 'ASSISTANT_COACH', name: 'Assistant Coach' }),
      ];

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.teamRole.findMany as jest.Mock).mockResolvedValue(roles);

      const result = await TeamService.getTeamRoles(team.id, admin.id);

      expect(mockPrisma.teamRole.findMany).toHaveBeenCalledWith({
        where: { teamId: team.id },
        select: expect.objectContaining({ type: true, name: true, canManageTeam: true }),
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

      const error = await TeamService.getTeamRoles(team.id, outsider.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have access to this team');
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

      // Managed user + membership are written in one transaction (audit #70).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
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
