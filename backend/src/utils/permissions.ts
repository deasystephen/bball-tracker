/**
 * Permission helpers for role-based access control
 */

import prisma from '../models';
import { Prisma, TeamStaff, UserRole } from '@prisma/client';

/** Prisma client or transaction client — the subset of methods helpers need. */
type Db = Prisma.TransactionClient | typeof prisma;

export interface TeamPermissions {
  canManageTeam: boolean;
  canManageRoster: boolean;
  canTrackStats: boolean;
  canViewStats: boolean;
  canShareStats: boolean;
}

const NO_PERMISSIONS: TeamPermissions = {
  canManageTeam: false,
  canManageRoster: false,
  canTrackStats: false,
  canViewStats: false,
  canShareStats: false,
};

const ALL_PERMISSIONS: TeamPermissions = {
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

/**
 * Get a user's permissions for a specific team
 */
export async function getTeamPermissions(
  userId: string,
  teamId: string
): Promise<TeamPermissions> {
  // First check if user is a system admin
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (user?.role === UserRole.ADMIN) {
    return ALL_PERMISSIONS;
  }

  // Check if user is a league admin for this team's league
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: {
      season: {
        include: {
          league: {
            include: {
              admins: {
                where: { userId },
              },
            },
          },
        },
      },
    },
  });

  if (team?.season?.league?.admins && team.season.league.admins.length > 0) {
    return ALL_PERMISSIONS;
  }

  // Check team staff roles
  const staffRoles = await prisma.teamStaff.findMany({
    where: {
      teamId,
      userId,
    },
    include: {
      role: true,
    },
  });

  if (staffRoles.length === 0) {
    // Check if user is a team member (player) - they get view permissions
    const isMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId,
          playerId: userId,
        },
      },
    });

    if (isMember) {
      return {
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: false,
        canViewStats: true,
        canShareStats: false,
      };
    }

    return NO_PERMISSIONS;
  }

  // Aggregate permissions from all roles (user might have multiple roles)
  const permissions: TeamPermissions = { ...NO_PERMISSIONS };
  for (const staffRole of staffRoles) {
    if (staffRole.role.canManageTeam) permissions.canManageTeam = true;
    if (staffRole.role.canManageRoster) permissions.canManageRoster = true;
    if (staffRole.role.canTrackStats) permissions.canTrackStats = true;
    if (staffRole.role.canViewStats) permissions.canViewStats = true;
    if (staffRole.role.canShareStats) permissions.canShareStats = true;
  }

  return permissions;
}

/**
 * Check if user has a specific permission on a team
 */
export async function hasTeamPermission(
  userId: string,
  teamId: string,
  permission: keyof TeamPermissions
): Promise<boolean> {
  const permissions = await getTeamPermissions(userId, teamId);
  return permissions[permission];
}

/**
 * Check if user has access to view a team (any role or member)
 */
export async function canAccessTeam(userId: string, teamId: string): Promise<boolean> {
  // System admin can access any team
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (user?.role === UserRole.ADMIN) {
    return true;
  }

  // Check if league admin
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: {
      season: {
        include: {
          league: {
            include: {
              admins: {
                where: { userId },
              },
            },
          },
        },
      },
    },
  });

  if (team?.season?.league?.admins && team.season.league.admins.length > 0) {
    return true;
  }

  // Check if team staff
  const isStaff = await prisma.teamStaff.findFirst({
    where: { teamId, userId },
  });

  if (isStaff) {
    return true;
  }

  // Check if team member
  const isMember = await prisma.teamMember.findUnique({
    where: {
      teamId_playerId: {
        teamId,
        playerId: userId,
      },
    },
  });

  return !!isMember;
}

export interface PlayerTeamAccess {
  /** Every team the player is currently rostered on. */
  memberTeamIds: string[];
  /**
   * The subset of `memberTeamIds` on which `userId` has `canManageRoster`
   * (staff with a roster-managing role, league admin of the team's league,
   * or system ADMIN — for whom this equals `memberTeamIds`).
   */
  manageableTeamIds: string[];
}

/**
 * Which of a player's teams can `userId` manage the roster of?
 *
 * Single query over the player's memberships; used to scope "act on behalf
 * of another player" operations (invitation listing, managed-player edits)
 * to a *current* roster relationship instead of a global role or a
 * never-expiring `managedById` link.
 */
export async function getPlayerTeamAccess(
  userId: string,
  playerId: string
): Promise<PlayerTeamAccess> {
  const memberships = await prisma.teamMember.findMany({
    where: { playerId },
    select: {
      teamId: true,
      team: {
        select: {
          season: { select: { league: { select: { admins: { where: { userId }, select: { id: true } } } } } },
          staff: { where: { userId, role: { canManageRoster: true } }, select: { id: true } },
        },
      },
    },
  });

  const memberTeamIds = memberships.map(m => m.teamId);
  const manageableTeamIds = memberships
    .filter(m => m.team.staff.length > 0 || m.team.season.league.admins.length > 0)
    .map(m => m.teamId);

  // Only consult the global role when the per-team rows grant nothing.
  if (
    memberTeamIds.length > 0 &&
    manageableTeamIds.length < memberTeamIds.length &&
    (await isSystemAdmin(userId))
  ) {
    return { memberTeamIds, manageableTeamIds: memberTeamIds };
  }

  return { memberTeamIds, manageableTeamIds };
}

/**
 * Check if user is a system admin
 */
export async function isSystemAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  return user?.role === UserRole.ADMIN;
}

/**
 * Check if user is a league admin for a specific league
 */
export async function isLeagueAdmin(userId: string, leagueId: string): Promise<boolean> {
  // System admin is also a league admin
  if (await isSystemAdmin(userId)) {
    return true;
  }

  const leagueAdmin = await prisma.leagueAdmin.findUnique({
    where: {
      leagueId_userId: {
        leagueId,
        userId,
      },
    },
  });

  return !!leagueAdmin;
}

/**
 * Whether the user holds a HEAD_COACH-type staff row on the team.
 *
 * Head Coach and Assistant Coach share the same permission *flags* (both can
 * manage the team and roster), so flag checks cannot tell them apart. The
 * staff-management rule ("who may add/remove staff, delete the team or move it
 * to another season") is keyed off the role TYPE instead — no schema change
 * needed. See `canManageStaff`.
 */
export async function isHeadCoach(userId: string, teamId: string): Promise<boolean> {
  const row = await prisma.teamStaff.findFirst({
    where: { teamId, userId, role: { type: 'HEAD_COACH' } },
    select: { id: true },
  });
  return !!row;
}

/**
 * Whether the user may manage the team's staff roster (add/remove/re-role
 * staff), delete the team, or move it to another season.
 *
 * Allowed: system ADMIN, an admin of the team's league, or a HEAD_COACH-type
 * staff member. Assistant coaches keep manageTeam/roster/track/view/share but
 * are NOT allowed here.
 */
export async function canManageStaff(userId: string, teamId: string): Promise<boolean> {
  if (await isSystemAdmin(userId)) {
    return true;
  }

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { season: { select: { leagueId: true } } },
  });

  if (team?.season) {
    const leagueAdmin = await prisma.leagueAdmin.findUnique({
      where: { leagueId_userId: { leagueId: team.season.leagueId, userId } },
    });
    if (leagueAdmin) {
      return true;
    }
  }

  return isHeadCoach(userId, teamId);
}

/**
 * Number of DISTINCT teams the user is staff on.
 *
 * A user can hold several roles on one team (one `TeamStaff` row per role), so
 * `teamStaff.count` over-counts; the FREE-tier team cap must count teams, not
 * rows (audit B2.8). Accepts a transaction client so the create-team
 * transaction can recount behind its row lock.
 */
export async function countDistinctStaffTeams(userId: string, db: Db = prisma): Promise<number> {
  const rows = await db.teamStaff.findMany({
    where: { userId },
    distinct: ['teamId'],
    select: { teamId: true },
  });
  return rows.length;
}

/**
 * Create default team roles when a new team is created
 */
export async function createDefaultTeamRoles(
  teamId: string,
  db: Prisma.TransactionClient = prisma
): Promise<void> {
  await db.teamRole.createMany({
    data: [
      {
        teamId,
        type: 'HEAD_COACH',
        name: 'Head Coach',
        description: 'Primary team coach with full administrative access',
        canManageTeam: true,
        canManageRoster: true,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
      {
        teamId,
        type: 'ASSISTANT_COACH',
        name: 'Assistant Coach',
        description: 'Assistant coach with team management access',
        canManageTeam: true,
        canManageRoster: true,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
      {
        teamId,
        type: 'TEAM_MANAGER',
        name: 'Team Manager',
        description: 'Team volunteer who helps with game day operations',
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
    ],
  });
}

/**
 * Assign a user to a team role
 */
export async function assignTeamRole(
  teamId: string,
  userId: string,
  roleName: string,
  db: Prisma.TransactionClient = prisma
): Promise<TeamStaff> {
  const role = await db.teamRole.findUnique({
    where: {
      teamId_name: {
        teamId,
        name: roleName,
      },
    },
  });

  if (!role) {
    throw new Error(`Role "${roleName}" not found for team`);
  }

  return db.teamStaff.create({
    data: {
      teamId,
      userId,
      roleId: role.id,
    },
  });
}
