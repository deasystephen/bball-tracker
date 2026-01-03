/**
 * League service layer for business logic
 */

import prisma from '../models';
import { CreateLeagueInput, UpdateLeagueInput, LeagueQueryParams } from '../api/leagues/schemas';
import { NotFoundError, BadRequestError } from '../utils/errors';

export class LeagueService {
  /**
   * Create a new league
   * @param data League creation data
   */
  static async createLeague(data: CreateLeagueInput) {
    // Check if league with same name, season, and year already exists
    const existing = await prisma.league.findFirst({
      where: {
        name: data.name,
        season: data.season,
        year: data.year,
      },
    });

    if (existing) {
      throw new BadRequestError('League with this name, season, and year already exists');
    }

    // Create the league
    const league = await prisma.league.create({
      data: {
        name: data.name,
        season: data.season,
        year: data.year,
      },
      include: {
        teams: {
          include: {
            coach: {
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

    return league;
  }

  /**
   * Get a league by ID
   * @param leagueId League ID
   */
  static async getLeagueById(leagueId: string) {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: {
        teams: {
          include: {
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
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    return league;
  }

  /**
   * List leagues with filters
   * @param query Query parameters
   */
  static async listLeagues(query: LeagueQueryParams) {
    // Build where clause
    const where: any = {};

    if (query.year !== undefined) {
      where.year = query.year;
    }

    if (query.season !== undefined) {
      where.season = query.season;
    }

    // Get total count
    const total = await prisma.league.count({ where });

    // Get leagues
    const leagues = await prisma.league.findMany({
      where,
      include: {
        teams: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [
        { year: 'desc' },
        { season: 'asc' },
        { name: 'asc' },
      ],
      take: query.limit,
      skip: query.offset,
    });

    return {
      leagues,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Update a league
   * @param leagueId League ID
   * @param data Update data
   */
  static async updateLeague(leagueId: string, data: UpdateLeagueInput) {
    // Get league
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    // Build update data
    const updateData: any = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.season !== undefined) {
      updateData.season = data.season;
    }

    if (data.year !== undefined) {
      updateData.year = data.year;
    }

    // Update the league
    const updatedLeague = await prisma.league.update({
      where: { id: leagueId },
      data: updateData,
      include: {
        teams: {
          include: {
            coach: {
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

    return updatedLeague;
  }

  /**
   * Delete a league
   * @param leagueId League ID
   */
  static async deleteLeague(leagueId: string) {
    // Get league
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: {
        teams: true,
      },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    // Check if league has teams
    if (league.teams.length > 0) {
      throw new BadRequestError('Cannot delete league with existing teams. Remove teams first.');
    }

    // Delete the league
    await prisma.league.delete({
      where: { id: leagueId },
    });

    return { success: true };
  }
}
