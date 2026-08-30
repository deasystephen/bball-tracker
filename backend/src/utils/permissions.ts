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

/** Rostered players and guardians of rostered players: read-only. */
const VIEW_ONLY_PERMISSIONS: TeamPermissions = {
  canManageTeam: false,
  canManageRoster: false,
  canTrackStats: false,
  canViewStats: true,
  canShareStats: false,
};

/**
 * Is `userId` a guardian (PARENT role link) of `childId`?
 */
export async function isGuardianOf(userId: string, childId: string): Promise<boolean> {
  const link = await prisma.guardian.findUnique({
    where: { parentId_childId: { parentId: userId, childId } },
    select: { id: true },
  });
  return !!link;
}

/**
 * Is `userId` a guardian of any current member of `teamId`?
 */
export async function isGuardianOfTeamMember(userId: string, teamId: string): Promise<boolean> {
  const link = await prisma.guardian.findFirst({
    where: {
      parentId: userId,
      child: { teamMembers: { some: { teamId } } },
    },
    select: { id: true },
  });
  return !!link;
}

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
      return VIEW_ONLY_PERMISSIONS;
    }

    // Guardian of a current member (PARENT role) — read-only, like a member.
    if (await isGuardianOfTeamMember(userId, teamId)) {
      return VIEW_ONLY_PERMISSIONS;
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

  if (isMember) {
    return true;
  }

  // Guardian of a current member (PARENT role) gets the member's read set
  return isGuardianOfTeamMember(userId, teamId);
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

/* ===========================================================================
 * League access (#442 / #443)
 *
 * Two named entry points per level, never one function with a `level`
 * argument. The read set is a strict SUPERSET of the write set, so calling the
 * wrong one at a write site is a silent privilege escalation with no type
 * error and no crash, while the reverse is a loud reported bug. Named
 * functions keep the dangerous call greppable.
 *
 *   read  = league admin | personal owner | staff | member | guardian-of-member
 *   write = league admin | personal owner | staff
 *
 * A member or guardian is deliberately NOT a writer: they are members of teams
 * inside a coach's personal league, and granting write there would let them
 * plant a team in somebody else's container.
 * ======================================================================== */

/**
 * Child player ids for a guardian.
 *
 * Lives here rather than in `GuardianService` so the predicates below can use
 * it without a service -> util -> service cycle (`guardian-service.ts` already
 * imports this module). `GuardianService.getChildIds` delegates here so there
 * is exactly one implementation.
 */
export async function getGuardianChildIds(userId: string): Promise<string[]> {
  const links = await prisma.guardian.findMany({
    where: { parentId: userId },
    select: { childId: true },
  });
  // `?? []` retained from the original GuardianService implementation: test
  // doubles and a mocked client can return undefined here.
  return (links ?? []).map((l) => l.childId);
}

/**
 * The caller-access clause for teams: staff OR member OR league admin OR
 * guardian of a member. Exported so `TeamService.listTeams` and the league
 * predicates below share ONE definition and can never drift apart.
 */
export function teamAccessWhere(userId: string, childIds: string[]): Prisma.TeamWhereInput {
  return {
    OR: [
      { staff: { some: { userId } } },
      { members: { some: { playerId: userId } } },
      { season: { league: { admins: { some: { userId } } } } },
      ...(childIds.length > 0 ? [{ members: { some: { playerId: { in: childIds } } } }] : []),
    ],
  };
}

/**
 * League ids the caller may READ, for the list endpoints (#443).
 *
 * Resolved from the TEAM side rather than by scanning `League` with nested
 * `some` clauses: after #442 the League table grows one row per coach, whereas
 * this query is bounded by the caller's own teams. Three indexed queries,
 * unioned in JS.
 *
 * System ADMINs are unscoped and must not call this — the list services skip
 * it entirely for them.
 */
export async function getReadableLeagueIds(userId: string): Promise<string[]> {
  const childIds = await getGuardianChildIds(userId);

  const [adminRows, personalLeague, teamRows] = await Promise.all([
    prisma.leagueAdmin.findMany({ where: { userId }, select: { leagueId: true } }),
    prisma.league.findUnique({ where: { personalOwnerId: userId }, select: { id: true } }),
    prisma.team.findMany({
      where: teamAccessWhere(userId, childIds),
      select: { season: { select: { leagueId: true } } },
    }),
  ]);

  // No cap. Truncating an authorization set would silently drop leagues from
  // both `count` and `findMany`, making `total` lie; the union is naturally
  // bounded by the caller's team count.
  const ids = new Set<string>(adminRows.map((r) => r.leagueId));
  if (personalLeague) ids.add(personalLeague.id);
  for (const t of teamRows) ids.add(t.season.leagueId);

  return [...ids];
}

/** Whether the caller owns this league as their auto-provisioned container. */
async function isPersonalLeagueOwner(userId: string, leagueId: string): Promise<boolean> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { personalOwnerId: true },
  });
  return league?.personalOwnerId === userId;
}

/** Whether the caller holds a staff row on any team in this league. */
async function isStaffInLeague(userId: string, leagueId: string): Promise<boolean> {
  const count = await prisma.team.count({
    where: { season: { leagueId }, staff: { some: { userId } } },
  });
  return count > 0;
}

/**
 * May the caller create or move a team into this league?
 *
 * An existence check on one known league id, not membership in a materialized
 * set — the callers ask a boolean question, so each branch is a single indexed
 * probe and they short-circuit.
 */
export async function canWriteLeague(userId: string, leagueId: string): Promise<boolean> {
  if (await isLeagueAdmin(userId, leagueId)) return true; // covers system ADMIN
  if (await isPersonalLeagueOwner(userId, leagueId)) return true;
  return isStaffInLeague(userId, leagueId);
}

/**
 * May the caller see this league at all? The write set, plus members of a team
 * in it and guardians of those members.
 *
 * An existence check on one known league id, not membership in a materialized
 * set — `getLeagueById` / `getSeasonById` ask a boolean question.
 */
export async function canReadLeague(userId: string, leagueId: string): Promise<boolean> {
  if (await canWriteLeague(userId, leagueId)) return true;

  const childIds = await getGuardianChildIds(userId);
  const playerIds = [userId, ...childIds];

  const count = await prisma.team.count({
    where: { season: { leagueId }, members: { some: { playerId: { in: playerIds } } } },
  });
  return count > 0;
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
