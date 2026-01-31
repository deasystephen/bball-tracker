/**
 * Player service layer for business logic
 */

import prisma from '../models';
import {
  CreatePlayerInput,
  UpdatePlayerInput,
  PlayerQueryParams,
} from '../api/players/schemas';
import {
  NotFoundError,
  BadRequestError,
} from '../utils/errors';

export class PlayerService {
  /**
   * Create a new player
   * @param data Player creation data
   * @param _userId ID of the user creating the player (for authorization - reserved for future use)
   */
  static async createPlayer(data: CreatePlayerInput, _userId: string) {
    // Check if user with this email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestError('A user with this email already exists');
    }

    // Create the player (as a User with role PLAYER)
    const player = await prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        role: 'PLAYER',
        profilePictureUrl: data.profilePictureUrl || null,
        emailVerified: false, // Will be verified through WorkOS when they sign up
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        profilePictureUrl: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return player;
  }

  /**
   * Get a player by ID
   * @param playerId Player ID
   */
  static async getPlayerById(playerId: string) {
    const player = await prisma.user.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        profilePictureUrl: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        teamMembers: {
          include: {
            team: {
              select: {
                id: true,
                name: true,
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
              },
            },
          },
        },
      },
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    // Only return players (users with role PLAYER)
    if (player.role !== 'PLAYER') {
      throw new NotFoundError('Player not found');
    }

    return player;
  }

  /**
   * List players with optional filters
   * @param params Query parameters
   */
  static async listPlayers(params: PlayerQueryParams) {
    const { search, role, limit, offset } = params;

    // Build where clause
    const where: any = {
      role: role || 'PLAYER', // Default to PLAYER role
    };

    // Add search filter if provided
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Get total count for pagination
    const total = await prisma.user.count({ where });

    // Get players
    const players = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        profilePictureUrl: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            teamMembers: true, // Count of teams this player is on
          },
        },
      },
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
    });

    return {
      players,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  /**
   * Update a player
   * @param playerId Player ID
   * @param data Update data
   * @param userId User ID (for authorization - admins can update any player)
   */
  static async updatePlayer(
    playerId: string,
    data: UpdatePlayerInput,
    userId: string
  ) {
    // Get player
    const player = await prisma.user.findUnique({
      where: { id: playerId },
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    // Verify it's actually a player
    if (player.role !== 'PLAYER') {
      throw new NotFoundError('Player not found');
    }

    // Check permissions
    // For now, only allow admins or the player themselves to update
    // TODO: Add admin role check
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!currentUser) {
      throw new NotFoundError('User not found');
    }

    // Allow player to update themselves, or admin to update any player
    // For now, we'll allow any authenticated user (can be refined later)
    // if (playerId !== userId && currentUser.role !== 'ADMIN') {
    //   throw new ForbiddenError('You can only update your own profile');
    // }

    // Check if email is being changed and if it's already taken
    if (data.email && data.email !== player.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new BadRequestError('A user with this email already exists');
      }
    }

    // Update player
    const updatedPlayer = await prisma.user.update({
      where: { id: playerId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.email && { email: data.email }),
        ...(data.profilePictureUrl !== undefined && {
          profilePictureUrl: data.profilePictureUrl || null,
        }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        profilePictureUrl: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return updatedPlayer;
  }

  /**
   * Delete a player
   * @param playerId Player ID
   * @param _userId User ID (for authorization - reserved for future use)
   */
  static async deletePlayer(playerId: string, _userId: string) {
    // Get player
    const player = await prisma.user.findUnique({
      where: { id: playerId },
      include: {
        teamMembers: true,
        gameEvents: true,
      },
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    // Verify it's actually a player
    if (player.role !== 'PLAYER') {
      throw new NotFoundError('Player not found');
    }

    // Check permissions
    // TODO: Add admin role check
    // For now, we'll allow deletion (can be restricted later)

    // Check if player is on any teams
    if (player.teamMembers.length > 0) {
      throw new BadRequestError(
        'Cannot delete player who is currently on teams. Remove player from all teams first.'
      );
    }

    // Check if player has game events
    if (player.gameEvents.length > 0) {
      throw new BadRequestError(
        'Cannot delete player with game history. Player data must be preserved for statistics.'
      );
    }

    // Delete player
    await prisma.user.delete({
      where: { id: playerId },
    });

    return { success: true };
  }
}
