/**
 * Permission helpers for role-based access control
 */

import prisma from '../models';
import { UserRole } from '@prisma/client';

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
 * Create default team roles when a new team is created
 */
export async function createDefaultTeamRoles(teamId: string) {
  await prisma.teamRole.createMany({
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
  roleName: string
) {
  const role = await prisma.teamRole.findUnique({
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

  return prisma.teamStaff.create({
    data: {
      teamId,
      userId,
      roleId: role.id,
    },
  });
}
