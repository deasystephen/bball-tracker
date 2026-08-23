/**
 * Player service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import {
  CreatePlayerInput,
  UpdatePlayerInput,
  PlayerQueryParams,
} from '../api/players/schemas';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  ConflictError,
} from '../utils/errors';
import { deletePreviousAvatar } from './upload-service';

const PLAYER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  profilePictureUrl: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const PLAYER_DETAIL_SELECT = {
  ...PLAYER_SELECT,
  isManaged: true,
  managedById: true,
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
} satisfies Prisma.UserSelect;

const PLAYER_LIST_SELECT = {
  ...PLAYER_SELECT,
  _count: {
    select: {
      teamMembers: true,
    },
  },
} satisfies Prisma.UserSelect;

/** List payload for non-admin callers: identical to PLAYER_LIST_SELECT minus `email` (audit #3). */
const PLAYER_LIST_PUBLIC_SELECT = {
  ...PLAYER_LIST_SELECT,
  email: false,
} satisfies Prisma.UserSelect;

export type Player = Prisma.UserGetPayload<{ select: typeof PLAYER_SELECT }>;
export type PlayerDetail = Prisma.UserGetPayload<{ select: typeof PLAYER_DETAIL_SELECT }>;
/** `email` is only present when the caller is a system ADMIN. */
export type PlayerListItem = Prisma.UserGetPayload<{ select: typeof PLAYER_LIST_PUBLIC_SELECT }> & {
  email?: string | null;
};

/** The authenticated caller, as attached to `req.user` by the auth middleware. */
export interface PlayerCaller {
  id: string;
  role: string;
}

/**
 * Prisma filter for "users who share at least one team with `userId`" —
 * i.e. members of any team the caller plays on or is staff of.
 */
function sharesTeamWith(userId: string): Prisma.UserWhereInput {
  return {
    teamMembers: {
      some: {
        team: {
          OR: [
            { members: { some: { playerId: userId } } },
            { staff: { some: { userId } } },
          ],
        },
      },
    },
  };
}

export interface PlayerList {
  players: PlayerListItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export class PlayerService {
  /**
   * Create a new (not yet signed-up) player account for an email address.
   *
   * Pre-creating a row binds that email to a User that `syncUser` will claim
   * on first sign-in, so this is restricted to system ADMINs and to staff who
   * manage a roster somewhere (team staff with `canManageRoster`, league
   * admins) — the "create & invite" flow (audit #2). Roster-only players
   * without an email go through `POST /teams/:id/managed-players`.
   * @param data Player creation data
   * @param caller The authenticated user
   */
  static async createPlayer(data: CreatePlayerInput, caller: PlayerCaller): Promise<Player> {
    if (caller.role !== 'ADMIN' && !(await PlayerService.isRosterManager(caller.id))) {
      throw new ForbiddenError('Only administrators and team staff who manage a roster can create players');
    }

    // Check if user with this email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestError('A user with this email already exists');
    }

    try {
      // Create the player (as a User with role PLAYER)
      return await prisma.user.create({
        data: {
          email: data.email,
          name: data.name,
          role: 'PLAYER',
          profilePictureUrl: data.profilePictureUrl || null,
          emailVerified: false, // Will be verified through WorkOS when they sign up
        },
        select: PLAYER_SELECT,
      });
    } catch (error) {
      throw PlayerService.mapUniqueViolation(error);
    }
  }

  /** True when the user is staff with `canManageRoster` on any team, or a league admin. */
  private static async isRosterManager(userId: string): Promise<boolean> {
    const [staff, leagueAdmin] = await Promise.all([
      prisma.teamStaff.findFirst({
        where: { userId, role: { canManageRoster: true } },
        select: { id: true },
      }),
      prisma.leagueAdmin.findFirst({ where: { userId }, select: { id: true } }),
    ]);
    return Boolean(staff || leagueAdmin);
  }

  /** Convert a Prisma unique-constraint violation on `email` into a 409. */
  private static mapUniqueViolation(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictError('A user with this email already exists');
    }
    return error;
  }

  /**
   * Get a player by ID.
   *
   * System admins can look up any player. Everyone else can only see
   * themselves or players who share a team with them; anything else is a 404
   * so player ids cannot be enumerated (audit #3). `email` is only returned
   * to admins and to the player themselves.
   * @param playerId Player ID
   * @param caller The authenticated user
   */
  static async getPlayerById(playerId: string, caller: PlayerCaller): Promise<PlayerDetail> {
    const player = await prisma.user.findUnique({
      where: { id: playerId },
      select: PLAYER_DETAIL_SELECT,
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    // Only return players (users with role PLAYER)
    if (player.role !== 'PLAYER') {
      throw new NotFoundError('Player not found');
    }

    const isAdmin = caller.role === 'ADMIN';
    const isSelf = caller.id === playerId;

    if (!isAdmin && !isSelf) {
      const shared = await prisma.user.findFirst({
        where: { id: playerId, ...sharesTeamWith(caller.id) },
        select: { id: true },
      });
      if (!shared) {
        throw new NotFoundError('Player not found');
      }
      return { ...player, email: null };
    }

    return player;
  }

  /**
   * List players with optional filters.
   *
   * Non-admin callers are scoped to themselves plus users who share a team
   * with them; the `role` / `isManaged` filters are admin-only (ignored for
   * everyone else), `search` matches name only for non-admins, and `email` is
   * omitted from non-admin results (audit #3).
   * @param params Query parameters
   * @param caller The authenticated user
   */
  static async listPlayers(params: PlayerQueryParams, caller: PlayerCaller): Promise<PlayerList> {
    const { search, role, isManaged, limit, offset } = params;
    const isAdmin = caller.role === 'ADMIN';

    const where: Prisma.UserWhereInput = {
      // Default to PLAYER role; only admins may list other roles
      role: isAdmin && role ? role : 'PLAYER',
      // Exclude managed players by default; only admins may include them
      isManaged: isAdmin && isManaged !== undefined ? isManaged : false,
    };

    const conditions: Prisma.UserWhereInput[] = [];

    if (!isAdmin) {
      conditions.push({ OR: [{ id: caller.id }, sharesTeamWith(caller.id)] });
    }

    if (search) {
      const nameMatch: Prisma.UserWhereInput = { name: { contains: search, mode: 'insensitive' } };
      conditions.push(
        isAdmin
          ? { OR: [nameMatch, { email: { contains: search, mode: 'insensitive' } }] }
          : nameMatch
      );
    }

    if (conditions.length > 0) {
      where.AND = conditions;
    }

    // Get total count and players in parallel
    const [total, players] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: isAdmin ? PLAYER_LIST_SELECT : PLAYER_LIST_PUBLIC_SELECT,
        orderBy: { name: 'asc' },
        take: limit,
        skip: offset,
      }),
    ]);

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
  ): Promise<Player> {
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

    // Check permissions - allow admins, the player themselves, or the managing coach
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!currentUser) {
      throw new NotFoundError('User not found');
    }

    const isManagedByUser = player.isManaged && player.managedById === userId;
    if (playerId !== userId && currentUser.role !== 'ADMIN' && !isManagedByUser) {
      throw new ForbiddenError('You can only update your own profile');
    }

    // Check if email is being changed and if it's already taken
    if (data.email && data.email !== player.email) {
      // Email is the login identity: it is bound to WorkOS by `syncUser`, so
      // rewriting it can pre-bind someone else's future sign-up to this row
      // (audit #2). Only admins may change it, plus the managing coach of a
      // managed player that has not been claimed by a real login yet.
      const unclaimedManaged = isManagedByUser && player.workosUserId === null;
      if (currentUser.role !== 'ADMIN' && !unclaimedManaged) {
        throw new ForbiddenError(
          playerId === userId
            ? 'Your email is managed by your login provider and cannot be changed here'
            : 'You cannot change the email of a player who has signed in'
        );
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new BadRequestError('A user with this email already exists');
      }
    }

    let updatedPlayer: Player;
    try {
      updatedPlayer = await prisma.user.update({
        where: { id: playerId },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.email && data.email !== player.email && { email: data.email }),
          ...(data.profilePictureUrl !== undefined && {
            profilePictureUrl: data.profilePictureUrl || null,
          }),
        },
        select: PLAYER_SELECT,
      });
    } catch (error) {
      throw PlayerService.mapUniqueViolation(error);
    }

    if (data.profilePictureUrl !== undefined) {
      await deletePreviousAvatar(player.profilePictureUrl, updatedPlayer.profilePictureUrl);
    }

    return updatedPlayer;
  }

  /**
   * Delete a player
   * @param playerId Player ID
   * @param userId User ID (for authorization)
   */
  static async deletePlayer(playerId: string, userId: string): Promise<{ success: true }> {
    // Check permissions - admins can delete any player, coaches can delete their managed players
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!currentUser) {
      throw new NotFoundError('User not found');
    }

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

    // Check permissions: admin or managing coach
    const isManagedByUser = player.isManaged && player.managedById === userId;
    if (currentUser.role !== 'ADMIN' && !isManagedByUser) {
      throw new ForbiddenError('Only administrators can delete players');
    }

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
