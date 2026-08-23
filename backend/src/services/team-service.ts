/**
 * Team service layer for business logic
 */

import { Prisma, TeamRole } from '@prisma/client';
import prisma from '../models';
import {
  CreateTeamInput,
  UpdateTeamInput,
  AddPlayerInput,
  UpdateTeamMemberInput,
  TeamQueryParams,
  CreateManagedPlayerInput,
} from '../api/teams/schemas';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import {
  hasTeamPermission,
  getTeamPermissions,
  canAccessTeam,
  isSystemAdmin,
  isLeagueAdmin,
  createDefaultTeamRoles,
  assignTeamRole,
} from '../utils/permissions';

const USER_SUMMARY_SELECT = {
  id: true,
  name: true,
  email: true,
  // Lets clients label roster-only (managed) players (audit #64)
  isManaged: true,
} satisfies Prisma.UserSelect;

const TEAM_SUMMARY_SELECT = {
  id: true,
  name: true,
} satisfies Prisma.TeamSelect;

const TEAM_STAFF_INCLUDE = {
  user: { select: USER_SUMMARY_SELECT },
  role: true,
} satisfies Prisma.TeamStaffInclude;

const TEAM_INCLUDE = {
  season: {
    include: {
      league: true,
    },
  },
  staff: { include: TEAM_STAFF_INCLUDE },
  members: {
    include: {
      player: { select: USER_SUMMARY_SELECT },
    },
  },
} satisfies Prisma.TeamInclude;

const TEAM_DETAIL_INCLUDE = {
  ...TEAM_INCLUDE,
  roles: true,
  games: {
    orderBy: {
      date: 'desc',
    },
    take: 10, // Latest 10 games
  },
} satisfies Prisma.TeamInclude;

const TEAM_LIST_INCLUDE = {
  season: {
    select: {
      id: true,
      name: true,
      league: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  _count: {
    select: {
      members: true,
      staff: true,
      games: true,
    },
  },
} satisfies Prisma.TeamInclude;

const TEAM_MEMBER_INCLUDE = {
  player: { select: USER_SUMMARY_SELECT },
  team: { select: TEAM_SUMMARY_SELECT },
} satisfies Prisma.TeamMemberInclude;

const MANAGED_MEMBER_INCLUDE = {
  player: {
    select: {
      ...USER_SUMMARY_SELECT,
      isManaged: true,
      managedById: true,
    },
  },
  team: { select: TEAM_SUMMARY_SELECT },
} satisfies Prisma.TeamMemberInclude;

const TEAM_ROLE_INCLUDE = {
  staff: {
    include: {
      user: { select: USER_SUMMARY_SELECT },
    },
  },
} satisfies Prisma.TeamRoleInclude;

export type TeamWithRelations = Prisma.TeamGetPayload<{ include: typeof TEAM_INCLUDE }>;
export type TeamDetail = Prisma.TeamGetPayload<{ include: typeof TEAM_DETAIL_INCLUDE }>;
type TeamDetailMember = TeamDetail['members'][number];
/**
 * `GET /teams/:id` payload. Member `player.email` is present only when the
 * caller has `canManageRoster` on the team (audit #80); other callers get
 * `{ id, name }` for each member's player.
 */
export type TeamDetailView = Omit<TeamDetail, 'members'> & {
  members: Array<
    Omit<TeamDetailMember, 'player'> & {
      player: Omit<TeamDetailMember['player'], 'email'> & { email?: string | null };
    }
  >;
};
export type TeamListItem = Prisma.TeamGetPayload<{ include: typeof TEAM_LIST_INCLUDE }>;
export type TeamMemberWithRelations = Prisma.TeamMemberGetPayload<{
  include: typeof TEAM_MEMBER_INCLUDE;
}>;
export type ManagedTeamMember = Prisma.TeamMemberGetPayload<{
  include: typeof MANAGED_MEMBER_INCLUDE;
}>;
export type TeamStaffWithRelations = Prisma.TeamStaffGetPayload<{
  include: typeof TEAM_STAFF_INCLUDE;
}>;
export type TeamRoleWithStaff = Prisma.TeamRoleGetPayload<{ include: typeof TEAM_ROLE_INCLUDE }>;

export interface TeamList {
  teams: TeamListItem[];
  total: number;
  limit: number;
  offset: number;
}

export class TeamService {
  /**
   * Create a new team
   * @param data Team creation data
   * @param userId ID of the user creating the team (will be assigned as Head Coach)
   */
  static async createTeam(
    data: CreateTeamInput,
    userId: string
  ): Promise<TeamWithRelations | null> {
    // Verify season exists
    const season = await prisma.season.findUnique({
      where: { id: data.seasonId },
      include: { league: true },
    });

    if (!season) {
      throw new NotFoundError('Season not found');
    }

    // Check if user can create teams in this league (league admin or system admin)
    const canCreate = await isLeagueAdmin(userId, season.leagueId);

    // For now, also allow any coach to create a team
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!canCreate && user?.role !== 'COACH') {
      throw new ForbiddenError('You do not have permission to create teams in this league');
    }

    // Create the team
    const team = await prisma.team.create({
      data: {
        name: data.name,
        seasonId: data.seasonId,
        chatLink: data.chatLink,
      },
    });

    // Create default roles for the team
    await createDefaultTeamRoles(team.id);

    // Assign the creating user as Head Coach
    await assignTeamRole(team.id, userId, 'Head Coach');

    // Return the full team with relations
    return prisma.team.findUnique({
      where: { id: team.id },
      include: TEAM_INCLUDE,
    });
  }

  /**
   * Get a team by ID
   * @param teamId Team ID
   * @param userId User ID (for authorization)
   */
  static async getTeamById(teamId: string, userId: string): Promise<TeamDetailView> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: TEAM_DETAIL_INCLUDE,
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check if user has access
    const hasAccess = await canAccessTeam(userId, teamId);

    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    // Roster managers (head/assistant coach, league admin, system admin) see
    // member emails; everyone else (players, stats-only staff) gets names only.
    const permissions = await getTeamPermissions(userId, teamId);
    if (permissions.canManageRoster) {
      return team;
    }

    return {
      ...team,
      members: team.members.map(({ player, ...member }) => ({
        ...member,
        player: { id: player.id, name: player.name },
      })),
    };
  }

  /**
   * List teams with filters
   * @param query Query parameters
   * @param userId User ID (for filtering by access)
   */
  static async listTeams(query: TeamQueryParams, userId: string): Promise<TeamList> {
    // Every clause is ANDed: the caller's access restriction always applies,
    // regardless of which optional filters are supplied (audit #11).
    const conditions: Prisma.TeamWhereInput[] = [];

    if (query.seasonId) {
      conditions.push({ seasonId: query.seasonId });
    }

    if (query.leagueId) {
      conditions.push({ season: { leagueId: query.leagueId } });
    }

    if (query.playerId) {
      conditions.push({ members: { some: { playerId: query.playerId } } });
    }

    // System admins see all teams; everyone else only teams they staff, play
    // on, or administer via the league.
    const isSysAdmin = await isSystemAdmin(userId);
    if (!isSysAdmin) {
      conditions.push({
        OR: [
          { staff: { some: { userId } } },
          { members: { some: { playerId: userId } } },
          { season: { league: { admins: { some: { userId } } } } },
        ],
      });
    }

    const where: Prisma.TeamWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    // Get total count and teams in parallel
    const [total, teams] = await Promise.all([
      prisma.team.count({ where }),
      prisma.team.findMany({
        where,
        include: TEAM_LIST_INCLUDE,
        orderBy: {
          createdAt: 'desc',
        },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    return {
      teams,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Update a team
   * @param teamId Team ID
   * @param data Update data
   * @param userId User ID (must have canManageTeam permission)
   */
  static async updateTeam(
    teamId: string,
    data: UpdateTeamInput,
    userId: string
  ): Promise<TeamWithRelations> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(userId, teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to update this team');
    }

    // If seasonId is being updated, verify the new season exists and that the
    // caller administers its league. Moving a team re-parents it under another
    // league's admins, so team-level canManageTeam is not enough (audit #13).
    if (data.seasonId && data.seasonId !== team.seasonId) {
      const season = await prisma.season.findUnique({
        where: { id: data.seasonId },
      });

      if (!season) {
        throw new NotFoundError('Season not found');
      }

      const canMoveIntoLeague = await isLeagueAdmin(userId, season.leagueId);
      if (!canMoveIntoLeague) {
        throw new ForbiddenError(
          'You do not have permission to move this team into that season'
        );
      }
    }

    // Build update data
    const updateData: Prisma.TeamUncheckedUpdateInput = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.seasonId !== undefined) {
      updateData.seasonId = data.seasonId;
    }

    if (data.chatLink !== undefined) {
      updateData.chatLink = data.chatLink;
    }

    // Update the team
    const updatedTeam = await prisma.team.update({
      where: { id: teamId },
      data: updateData,
      include: TEAM_INCLUDE,
    });

    return updatedTeam;
  }

  /**
   * Delete a team
   * @param teamId Team ID
   * @param userId User ID (must have canManageTeam permission)
   */
  static async deleteTeam(teamId: string, userId: string): Promise<{ success: true }> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(userId, teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to delete this team');
    }

    // Delete the team (cascade will handle members, staff, roles, and games)
    await prisma.team.delete({
      where: { id: teamId },
    });

    return { success: true };
  }

  /**
   * Add a player to a team
   * @param teamId Team ID
   * @param data Player data
   * @param userId User ID (must have canManageRoster permission)
   */
  static async addPlayer(
    teamId: string,
    data: AddPlayerInput,
    userId: string
  ): Promise<TeamMemberWithRelations> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to add players to this team');
    }

    // Verify player exists
    const player = await prisma.user.findUnique({
      where: { id: data.playerId },
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    // Check if player is already on the team
    const existingMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId,
          playerId: data.playerId,
        },
      },
    });

    if (existingMember) {
      throw new BadRequestError('Player is already on this team');
    }

    // Add player to team
    const teamMember = await prisma.teamMember.create({
      data: {
        teamId,
        playerId: data.playerId,
        jerseyNumber: data.jerseyNumber,
        position: data.position,
      },
      include: TEAM_MEMBER_INCLUDE,
    });

    return teamMember;
  }

  /**
   * Remove a player from a team
   * @param teamId Team ID
   * @param playerId Player ID
   * @param userId User ID (must have canManageRoster permission)
   */
  static async removePlayer(
    teamId: string,
    playerId: string,
    userId: string
  ): Promise<{ success: true }> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to remove players from this team');
    }

    // Check if player is on the team
    const teamMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId,
          playerId,
        },
      },
    });

    if (!teamMember) {
      throw new NotFoundError('Player is not on this team');
    }

    // Remove player from team
    await prisma.teamMember.delete({
      where: {
        teamId_playerId: {
          teamId,
          playerId,
        },
      },
    });

    return { success: true };
  }

  /**
   * Update a team member (jersey number, position)
   * @param teamId Team ID
   * @param playerId Player ID
   * @param data Update data
   * @param userId User ID (must have canManageRoster permission)
   */
  static async updateTeamMember(
    teamId: string,
    playerId: string,
    data: UpdateTeamMemberInput,
    userId: string
  ): Promise<TeamMemberWithRelations> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to update team members');
    }

    // Check if player is on the team
    const teamMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId,
          playerId,
        },
      },
    });

    if (!teamMember) {
      throw new NotFoundError('Player is not on this team');
    }

    // Build update data
    const updateData: Prisma.TeamMemberUpdateInput = {};

    if (data.jerseyNumber !== undefined) {
      updateData.jerseyNumber = data.jerseyNumber;
    }

    if (data.position !== undefined) {
      updateData.position = data.position;
    }

    // Update team member
    const updatedMember = await prisma.teamMember.update({
      where: {
        teamId_playerId: {
          teamId,
          playerId,
        },
      },
      data: updateData,
      include: TEAM_MEMBER_INCLUDE,
    });

    return updatedMember;
  }

  /**
   * Add a staff member to a team with a specific role
   * @param teamId Team ID
   * @param userId User to add as staff
   * @param roleName Role name (e.g., "Head Coach", "Assistant Coach", "Team Manager")
   * @param requestingUserId User making the request
   */
  static async addStaffMember(
    teamId: string,
    staffUserId: string,
    roleName: string,
    requestingUserId: string
  ): Promise<TeamStaffWithRelations> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(requestingUserId, teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: staffUserId },
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Get the role
    const role = await prisma.teamRole.findUnique({
      where: {
        teamId_name: {
          teamId,
          name: roleName,
        },
      },
    });

    if (!role) {
      throw new NotFoundError(`Role "${roleName}" not found for this team`);
    }

    // Check if user already has this role
    const existingStaff = await prisma.teamStaff.findUnique({
      where: {
        teamId_userId_roleId: {
          teamId,
          userId: staffUserId,
          roleId: role.id,
        },
      },
    });

    if (existingStaff) {
      throw new BadRequestError('User already has this role on the team');
    }

    // Add staff member
    const teamStaff = await prisma.teamStaff.create({
      data: {
        teamId,
        userId: staffUserId,
        roleId: role.id,
      },
      include: TEAM_STAFF_INCLUDE,
    });

    return teamStaff;
  }

  /**
   * Remove a staff member from a team role
   */
  static async removeStaffMember(
    teamId: string,
    staffUserId: string,
    roleName: string,
    requestingUserId: string
  ): Promise<{ success: true }> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(requestingUserId, teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }

    // Get the role
    const role = await prisma.teamRole.findUnique({
      where: {
        teamId_name: {
          teamId,
          name: roleName,
        },
      },
    });

    if (!role) {
      throw new NotFoundError(`Role "${roleName}" not found for this team`);
    }

    // Check if removing the last Head Coach
    if (role.type === 'HEAD_COACH') {
      const headCoaches = await prisma.teamStaff.count({
        where: {
          teamId,
          role: { type: 'HEAD_COACH' },
        },
      });

      if (headCoaches <= 1) {
        throw new BadRequestError('Cannot remove the last Head Coach. Assign another Head Coach first.');
      }
    }

    // Remove staff member
    await prisma.teamStaff.delete({
      where: {
        teamId_userId_roleId: {
          teamId,
          userId: staffUserId,
          roleId: role.id,
        },
      },
    });

    return { success: true };
  }

  /**
   * Create a custom volunteer role for a team
   */
  static async createCustomRole(
    teamId: string,
    data: {
      name: string;
      description?: string;
      canManageTeam?: boolean;
      canManageRoster?: boolean;
      canTrackStats?: boolean;
      canViewStats?: boolean;
      canShareStats?: boolean;
    },
    requestingUserId: string
  ): Promise<TeamRole> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(requestingUserId, teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to create team roles');
    }

    // Check if role name already exists
    const existingRole = await prisma.teamRole.findUnique({
      where: {
        teamId_name: {
          teamId,
          name: data.name,
        },
      },
    });

    if (existingRole) {
      throw new BadRequestError('A role with this name already exists');
    }

    // Create the role
    const role = await prisma.teamRole.create({
      data: {
        teamId,
        type: 'CUSTOM',
        name: data.name,
        description: data.description,
        canManageTeam: data.canManageTeam ?? false,
        canManageRoster: data.canManageRoster ?? false,
        canTrackStats: data.canTrackStats ?? false,
        canViewStats: data.canViewStats ?? true,
        canShareStats: data.canShareStats ?? false,
      },
    });

    return role;
  }

  /**
   * Get all roles for a team
   */
  static async getTeamRoles(teamId: string, userId: string): Promise<TeamRoleWithStaff[]> {
    // Check access
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const roles = await prisma.teamRole.findMany({
      where: { teamId },
      include: TEAM_ROLE_INCLUDE,
      orderBy: [
        { type: 'asc' },
        { name: 'asc' },
      ],
    });

    return roles;
  }

  /**
   * Add a managed player to a team (no email/account required - COPPA compliant)
   * @param teamId Team ID
   * @param data Managed player data
   * @param userId User ID of the coach creating the managed player
   */
  static async addManagedPlayer(
    teamId: string,
    data: CreateManagedPlayerInput,
    userId: string
  ): Promise<ManagedTeamMember> {
    // Verify team exists
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to manage this team\'s roster');
    }

    // Create managed user (no email, no account)
    const managedUser = await prisma.user.create({
      data: {
        name: data.name,
        role: 'PLAYER',
        isManaged: true,
        managedById: userId,
        email: null,
        profilePictureUrl: data.profilePictureUrl,
      },
    });

    // Create team member linking managed user to team
    const teamMember = await prisma.teamMember.create({
      data: {
        teamId,
        playerId: managedUser.id,
        jerseyNumber: data.jerseyNumber,
        position: data.position,
      },
      include: MANAGED_MEMBER_INCLUDE,
    });

    return teamMember;
  }
}
