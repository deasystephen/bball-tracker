/**
 * Team service layer for business logic
 */

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
  canAccessTeam,
  isSystemAdmin,
  isLeagueAdmin,
  createDefaultTeamRoles,
  assignTeamRole,
} from '../utils/permissions';

export class TeamService {
  /**
   * Create a new team
   * @param data Team creation data
   * @param userId ID of the user creating the team (will be assigned as Head Coach)
   */
  static async createTeam(data: CreateTeamInput, userId: string) {
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
      },
    });

    // Create default roles for the team
    await createDefaultTeamRoles(team.id);

    // Assign the creating user as Head Coach
    await assignTeamRole(team.id, userId, 'Head Coach');

    // Return the full team with relations
    return prisma.team.findUnique({
      where: { id: team.id },
      include: {
        season: {
          include: {
            league: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            role: true,
          },
        },
        members: {
          include: {
            player: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * Get a team by ID
   * @param teamId Team ID
   * @param userId User ID (for authorization)
   */
  static async getTeamById(teamId: string, userId: string) {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        season: {
          include: {
            league: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            role: true,
          },
        },
        roles: true,
        members: {
          include: {
            player: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        games: {
          orderBy: {
            date: 'desc',
          },
          take: 10, // Latest 10 games
        },
      },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check if user has access
    const hasAccess = await canAccessTeam(userId, teamId);

    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    return team;
  }

  /**
   * List teams with filters
   * @param query Query parameters
   * @param userId User ID (for filtering by access)
   */
  static async listTeams(query: TeamQueryParams, userId: string) {
    // Build where clause
    const where: any = {};

    if (query.seasonId) {
      where.seasonId = query.seasonId;
    }

    if (query.leagueId) {
      where.season = {
        leagueId: query.leagueId,
      };
    }

    if (query.playerId) {
      where.members = {
        some: {
          playerId: query.playerId,
        },
      };
    }

    // Check if user is system admin (can see all teams)
    const isSysAdmin = await isSystemAdmin(userId);

    // Filter by user access (staff or team member) unless admin
    if (!isSysAdmin && !query.seasonId && !query.leagueId && !query.playerId) {
      const userTeams = await prisma.team.findMany({
        where: {
          OR: [
            {
              staff: {
                some: {
                  userId,
                },
              },
            },
            {
              members: {
                some: {
                  playerId: userId,
                },
              },
            },
          ],
        },
        select: { id: true },
      });

      const teamIds = userTeams.map((team) => team.id);
      if (teamIds.length > 0) {
        where.id = { in: teamIds };
      } else {
        // User has no teams, return empty result
        return {
          teams: [],
          total: 0,
          limit: query.limit,
          offset: query.offset,
        };
      }
    }

    // Get total count and teams in parallel
    const [total, teams] = await Promise.all([
      prisma.team.count({ where }),
      prisma.team.findMany({
        where,
        include: {
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
        },
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
  static async updateTeam(teamId: string, data: UpdateTeamInput, userId: string) {
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

    // If seasonId is being updated, verify new season exists
    if (data.seasonId && data.seasonId !== team.seasonId) {
      const season = await prisma.season.findUnique({
        where: { id: data.seasonId },
      });

      if (!season) {
        throw new NotFoundError('Season not found');
      }
    }

    // Build update data
    const updateData: any = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.seasonId !== undefined) {
      updateData.seasonId = data.seasonId;
    }

    // Update the team
    const updatedTeam = await prisma.team.update({
      where: { id: teamId },
      data: updateData,
      include: {
        season: {
          include: {
            league: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            role: true,
          },
        },
        members: {
          include: {
            player: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    return updatedTeam;
  }

  /**
   * Delete a team
   * @param teamId Team ID
   * @param userId User ID (must have canManageTeam permission)
   */
  static async deleteTeam(teamId: string, userId: string) {
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
  static async addPlayer(teamId: string, data: AddPlayerInput, userId: string) {
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
      include: {
        player: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        team: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return teamMember;
  }

  /**
   * Remove a player from a team
   * @param teamId Team ID
   * @param playerId Player ID
   * @param userId User ID (must have canManageRoster permission)
   */
  static async removePlayer(teamId: string, playerId: string, userId: string) {
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
  ) {
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
    const updateData: any = {};

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
      include: {
        player: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        team: {
          select: {
            id: true,
            name: true,
          },
        },
      },
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
  ) {
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
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        role: true,
      },
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
  ) {
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
  ) {
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
  static async getTeamRoles(teamId: string, userId: string) {
    // Check access
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const roles = await prisma.teamRole.findMany({
      where: { teamId },
      include: {
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
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
  ) {
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
      include: {
        player: {
          select: {
            id: true,
            name: true,
            email: true,
            isManaged: true,
            managedById: true,
          },
        },
        team: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return teamMember;
  }
}
