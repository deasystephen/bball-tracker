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
} from '../api/teams/schemas';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';

export class TeamService {
  /**
   * Create a new team
   * @param data Team creation data
   * @param userId ID of the user creating the team (will be set as coach if coachId not provided)
   */
  static async createTeam(data: CreateTeamInput, userId: string) {
    // Verify league exists
    const league = await prisma.league.findUnique({
      where: { id: data.leagueId },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    // Use provided coachId or default to authenticated user
    const coachId = data.coachId || userId;

    // Verify coach exists
    const coach = await prisma.user.findUnique({
      where: { id: coachId },
    });

    if (!coach) {
      throw new NotFoundError('Coach not found');
    }

    // If coachId was provided and it's not the authenticated user, check permissions
    // For now, only allow users to create teams where they are the coach
    // TODO: Add admin role check
    if (data.coachId && data.coachId !== userId) {
      throw new ForbiddenError('You can only create teams where you are the coach');
    }

    // Create the team
    const team = await prisma.team.create({
      data: {
        name: data.name,
        leagueId: data.leagueId,
        coachId: coachId,
      },
      include: {
        league: true,
        coach: {
          select: {
            id: true,
            name: true,
            email: true,
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

    return team;
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
        league: true,
        coach: {
          select: {
            id: true,
            name: true,
            email: true,
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

    // Check if user has access (coach, team member, or admin)
    const hasAccess =
      team.coachId === userId ||
      team.members.some((member) => member.playerId === userId);

    // TODO: Add admin role check when roles are implemented

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

    if (query.leagueId) {
      where.leagueId = query.leagueId;
    }

    if (query.coachId) {
      where.coachId = query.coachId;
    }

    if (query.playerId) {
      where.members = {
        some: {
          playerId: query.playerId,
        },
      };
    }

    // Filter by user access (coach or team member)
    // If no specific filters, only show teams user has access to
    if (!query.leagueId && !query.coachId && !query.playerId) {
      const userTeams = await prisma.team.findMany({
        where: {
          OR: [
            { coachId: userId },
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

    // Get total count
    const total = await prisma.team.count({ where });

    // Get teams
    const teams = await prisma.team.findMany({
      where,
      include: {
        league: true,
        coach: {
          select: {
            id: true,
            name: true,
            email: true,
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
      orderBy: {
        createdAt: 'desc',
      },
      take: query.limit,
      skip: query.offset,
    });

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
   * @param userId User ID (must be coach)
   */
  static async updateTeam(teamId: string, data: UpdateTeamInput, userId: string) {
    // Get team and verify access
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can update the team');
    }

    // If leagueId is being updated, verify new league exists
    if (data.leagueId && data.leagueId !== team.leagueId) {
      const league = await prisma.league.findUnique({
        where: { id: data.leagueId },
      });

      if (!league) {
        throw new NotFoundError('League not found');
      }
    }

    // Build update data
    const updateData: any = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.leagueId !== undefined) {
      updateData.leagueId = data.leagueId;
    }

    // Update the team
    const updatedTeam = await prisma.team.update({
      where: { id: teamId },
      data: updateData,
      include: {
        league: true,
        coach: {
          select: {
            id: true,
            name: true,
            email: true,
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
   * @param userId User ID (must be coach)
   */
  static async deleteTeam(teamId: string, userId: string) {
    // Get team and verify access
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can delete the team');
    }

    // Delete the team (cascade will handle members and games)
    await prisma.team.delete({
      where: { id: teamId },
    });

    return { success: true };
  }

  /**
   * Add a player to a team
   * @param teamId Team ID
   * @param data Player data
   * @param userId User ID (must be coach)
   */
  static async addPlayer(teamId: string, data: AddPlayerInput, userId: string) {
    // Get team and verify access
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can add players');
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
   * @param userId User ID (must be coach)
   */
  static async removePlayer(teamId: string, playerId: string, userId: string) {
    // Get team and verify access
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can remove players');
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
   * @param userId User ID (must be coach)
   */
  static async updateTeamMember(
    teamId: string,
    playerId: string,
    data: UpdateTeamMemberInput,
    userId: string
  ) {
    // Get team and verify access
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can update team members');
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
}
