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
  AddStaffInput,
  StaffRoleType,
} from '../api/teams/schemas';
import { NotificationService } from './notification-service';
import { logger } from '../utils/logger';
import { GuardianService } from './guardian-service';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  PaymentRequiredError,
} from '../utils/errors';
import {
  Feature,
  canCreateTeam,
  featureCode,
  getEffectiveTier,
  getRequiredTier,
  getUsageLimits,
} from './entitlements';
import {
  hasTeamPermission,
  getTeamPermissions,
  canAccessTeam,
  isSystemAdmin,
  isLeagueAdmin,
  createDefaultTeamRoles,
  assignTeamRole,
  canManageStaff,
  countDistinctStaffTeams,
  teamAccessWhere,
  canWriteLeague,
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

/**
 * Roster order: jersey number asc (0 is valid, nulls last), name tiebreak.
 * Single source of truth — game-service's GAME_DETAIL_INCLUDE.team.members
 * and both services' tests import this rather than restating the literal.
 */
export const ROSTER_MEMBERS_ORDER_BY = [
  { jerseyNumber: { sort: 'asc', nulls: 'last' } },
  { player: { name: 'asc' } },
  // Final tiebreak: duplicate jersey+name rows (two "Alex Smith"s) would
  // otherwise have unspecified order and visibly swap between fetches.
  { id: 'asc' },
] satisfies Prisma.TeamMemberOrderByWithRelationInput[];

const TEAM_INCLUDE = {
  season: {
    include: {
      league: { omit: { personalOwnerId: true } },
    },
  },
  staff: { include: TEAM_STAFF_INCLUDE },
  members: {
    include: {
      player: { select: USER_SUMMARY_SELECT },
    },
    orderBy: ROSTER_MEMBERS_ORDER_BY,
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
  // Invite-status chips (roster/invite unification spec): PENDING drives the
  // Invited / Invite expired chips, ACCEPTED marks a player who accepted via
  // the public web link but has never signed in (isManaged is still true for
  // them, so isManaged alone would read "Not invited"). Never select `token`
  // here — it is a bearer secret (audit #14).
  invitations: {
    where: { status: { in: ['PENDING', 'ACCEPTED'] } },
    select: {
      id: true,
      playerId: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
    // PENDING is bounded by the partial unique index; ACCEPTED accumulates
    // over a team's lifetime, so cap the join far above any realistic roster
    // history (newest first — exactly what the chips need).
    orderBy: { createdAt: 'desc' as const },
    take: 200,
  },
} satisfies Prisma.TeamInclude;

/**
 * List items carry the CALLER's own staff row only (at most one per team,
 * same shape as the detail payload's rows). The client permission helpers
 * (mobile `hasTeamPermission` / `canManageAnyTeam`) need it: the Games-tab
 * create FAB and the game-create team picker are gated on the caller's staff
 * flags, and gating on a payload without `staff` hid game creation from every
 * coach (#469 — a #396 regression). Everyone else's staff rows stay out of
 * the list; the full staff comes from `GET /teams/:id` or `/teams/:id/staff`.
 */
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
  staff: {
    where: { userId: '' }, // placeholder — teamListInclude() narrows to the caller
    include: TEAM_STAFF_INCLUDE,
  },
  _count: {
    select: {
      members: true,
      staff: true,
      games: true,
    },
  },
} satisfies Prisma.TeamInclude;

const teamListInclude = (userId: string): typeof TEAM_LIST_INCLUDE => ({
  ...TEAM_LIST_INCLUDE,
  staff: { where: { userId }, include: TEAM_STAFF_INCLUDE },
});

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

const TEAM_ROLE_SELECT = {
  id: true,
  teamId: true,
  type: true,
  name: true,
  description: true,
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
} satisfies Prisma.TeamRoleSelect;

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
export type TeamRoleSummary = Prisma.TeamRoleGetPayload<{ select: typeof TEAM_ROLE_SELECT }>;
/**
 * `GET /teams/:id/staff` row. `user.email` is present only when the caller
 * has `canManageRoster` on the team (same rule as member emails, audit #80).
 */
export type TeamStaffView = Omit<TeamStaffWithRelations, 'user'> & {
  user: Omit<TeamStaffWithRelations['user'], 'email'> & { email?: string | null };
};

export interface TeamList {
  teams: TeamListItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Resolve (creating if needed) the caller's personal league and its
 * current-year season, for a team create that supplied no `seasonId` (#442).
 *
 * WHY THERE IS NO P2002 RETRY. This runs inside `createTeam`'s transaction,
 * AFTER the `SELECT ... FOR UPDATE` on the caller's own User row. That lock is
 * what makes it safe: `League.personalOwnerId` is unique per user and the
 * season lives only inside that user's own league, so the only writer that can
 * ever contend for either constraint is the same `userId`, and it is
 * serialized. Do NOT remove the lock on the belief that a retry covers this --
 * there is no retry. (A system ADMIN creating a same-named season in someone's
 * personal league via `POST /seasons` is the one theoretical contender; it is
 * not defended against.)
 *
 * Each `update` writes the unique key back to itself. A non-empty `update` is
 * what gives Prisma a chance at the native `INSERT ... ON CONFLICT` path
 * (prisma/prisma#9972), and writing any other field would clobber a later
 * rename of the coach's own league -- the ability to rename being the whole
 * reason the owner gets a `LeagueAdmin` row.
 */
async function resolvePersonalSeasonId(
  tx: Prisma.TransactionClient,
  userId: string,
  userName: string
): Promise<string> {
  const league = await tx.league.upsert({
    where: { personalOwnerId: userId },
    create: { name: `${userName}'s Teams`, personalOwnerId: userId },
    update: { personalOwnerId: userId },
    select: { id: true },
  });

  // Not nested inside the league upsert above: a nested write would disable
  // the native ON CONFLICT path. The owner gets a real LeagueAdmin row so they
  // can rename the league and add next year's season; it is filtered out of
  // the `leagueAdminOf` session payload so no admin UI appears.
  await tx.leagueAdmin.upsert({
    where: { leagueId_userId: { leagueId: league.id, userId } },
    create: { leagueId: league.id, userId },
    update: { userId },
    select: { id: true },
  });

  // Named for the year of creation. This does NOT roll over on its own --
  // carrying a roster into a new season is #461.
  const name = String(new Date().getFullYear());
  const season = await tx.season.upsert({
    where: { leagueId_name: { leagueId: league.id, name } },
    // Explicit rather than relying on the schema default: the mobile season
    // picker filters on isActive.
    create: { leagueId: league.id, name, isActive: true },
    update: { name },
    select: { id: true },
  });

  // The #442 signal. Note "resolved", not "provisioned": `upsert` cannot
  // distinguish a create from a reuse, so this fires on EVERY seasonId-less
  // create, not only the first. The metric is therefore distinct `userId` over
  // a window ("how many coaches self-served"), not a raw event count.
  logger.info('Resolved personal league for team create', {
    userId,
    leagueId: league.id,
    seasonId: season.id,
  });

  return season.id;
}

export class TeamService {
  /**
   * Create a new team.
   *
   * Authorization is TWO independent checks (#442):
   *
   *   WHO  -- may this caller create a team at all?  ADMIN / COACH / any
   *           league admin. Unchanged from the pre-#442 rule.
   *   WHERE -- may they create it in THIS league?    Only when a seasonId is
   *           supplied; see `canWriteLeague`.
   *
   * They are separate because the no-seasonId path has no target league to
   * check. Folding WHO into WHERE would leave that path ungated, and any
   * authenticated PLAYER or guardian could create a team and become its Head
   * Coach with all five permission flags.
   *
   * @param data Team creation data (`seasonId` optional -- omitted means "my
   *   own teams", which auto-provisions a personal league)
   * @param userId ID of the user creating the team (assigned as Head Coach)
   */
  static async createTeam(
    data: CreateTeamInput,
    userId: string
  ): Promise<TeamWithRelations | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, role: true, subscriptionTier: true, subscriptionExpiresAt: true },
    });

    // WHO. A missing user falls through to the same Forbidden. The
    // league-admin lookup is last so the two common cases (ADMIN, COACH) cost
    // no extra query.
    if (user?.role !== 'ADMIN' && user?.role !== 'COACH') {
      const administersALeague =
        !!user && (await prisma.leagueAdmin.count({ where: { userId } })) > 0;
      if (!administersALeague) {
        throw new ForbiddenError('You do not have permission to create teams');
      }
    }

    // WHERE. Never use the READ set here: a player or guardian rostered on a
    // coach's team is a *member* of a team in that coach's personal league, so
    // the read set would let them plant a team inside someone else's
    // container.
    if (data.seasonId) {
      const season = await prisma.season.findUnique({
        where: { id: data.seasonId },
        select: { id: true, leagueId: true },
      });

      if (!season) {
        throw new NotFoundError('Season not found');
      }

      if (!(await canWriteLeague(userId, season.leagueId))) {
        // The tightened write scope is this change's main regression risk, so a
        // denial is logged: a coach wrongly locked out would otherwise be
        // completely silent.
        logger.warn('Team create denied: caller cannot write to that league', {
          userId,
          seasonId: data.seasonId,
          leagueId: season.leagueId,
        });
        throw new ForbiddenError('You do not have permission to create teams in this league');
      }
    }

    // Team + default roles + Head Coach staff row are created atomically so a
    // failure part-way can't leave an orphan team nobody can see or delete
    // (audit #70). The FREE-tier cap is re-checked inside the same transaction
    // behind a row lock on the user, so concurrent creates serialize and the
    // check-then-act race in the route middleware can't exceed the cap
    // (audit #49). Admins bypass; unlimited tiers skip the count.
    //
    // Personal-league provisioning happens inside this same transaction and
    // AFTER the cap check, so a capped user never leaves a stray league behind.
    const team = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

      if (user && user.role !== 'ADMIN') {
        const tier = getEffectiveTier({
          subscriptionTier: user.subscriptionTier ?? 'FREE',
          subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
        });
        if (getUsageLimits(tier).maxTeams !== Infinity) {
          const teamCount = await countDistinctStaffTeams(userId, tx);
          if (!canCreateTeam(tier, teamCount)) {
            throw new PaymentRequiredError({
              feature: featureCode(Feature.UNLIMITED_TEAMS),
              currentTier: tier,
              requiredTier: getRequiredTier(Feature.UNLIMITED_TEAMS),
            });
          }
        }
      }

      const seasonId =
        data.seasonId ?? (await resolvePersonalSeasonId(tx, userId, user?.name ?? 'My'));

      const created = await tx.team.create({
        data: {
          name: data.name,
          seasonId,
          chatLink: data.chatLink,
        },
      });

      await createDefaultTeamRoles(created.id, tx);
      await assignTeamRole(created.id, userId, 'Head Coach', tx);

      return created;
    });

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
    // member emails and invite statuses; everyone else (players, stats-only
    // staff) gets names only — a teammate's invitation state is roster-
    // management information, same rule as emails (audit #80).
    const permissions = await getTeamPermissions(userId, teamId);
    if (permissions.canManageRoster) {
      // Per the unification spec, the payload carries invite statuses for
      // ROSTERED players only; case-3 (existing-account, not-yet-member)
      // invites come from GET /invitations?teamId= client-side (red-team RT7).
      const memberIds = new Set(team.members.map((m) => m.playerId));
      return {
        ...team,
        invitations: team.invitations.filter((inv) => memberIds.has(inv.playerId)),
      };
    }

    return {
      ...team,
      invitations: [],
      members: team.members.map(({ player, ...member }) => ({
        ...member,
        player: { id: player.id, name: player.name, isManaged: player.isManaged },
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
      // Guardians (PARENT role) see the teams their children play on — the
      // same read set `canAccessTeam` grants (docs/plans/parent-role-spec.md).
      const childIds = await GuardianService.getChildIds(userId);
      // Shared with the league-access predicates in `utils/permissions` so the
      // two definitions of "teams this caller may see" can never drift.
      conditions.push(teamAccessWhere(userId, childIds));
    }

    const where: Prisma.TeamWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    // Get total count and teams in parallel
    const [total, teams] = await Promise.all([
      prisma.team.count({ where }),
      prisma.team.findMany({
        where,
        include: teamListInclude(userId),
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
    // On the team side only a head coach (or league/system admin) may move it
    // — assistant coaches share canManageTeam but not this (role matrix B2.3).
    if (data.seasonId && data.seasonId !== team.seasonId) {
      const isHeadCoachOrAdmin = await canManageStaff(userId, teamId);
      if (!isHeadCoachOrAdmin) {
        throw new ForbiddenError('Only a head coach can move this team to another season');
      }

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
   * @param userId User ID (must be a head coach, league admin or system admin —
   *   assistant coaches share canManageTeam but cannot delete; role matrix B2.3)
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
    const canManage = await canManageStaff(userId, teamId);
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
   * List a team's staff (every role assignment) with user + role.
   * Any team member/staff/admin may read; emails are only included for
   * callers who can manage the roster.
   */
  static async listStaff(teamId: string, userId: string): Promise<TeamStaffView[]> {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const staff = await prisma.teamStaff.findMany({
      where: { teamId },
      include: TEAM_STAFF_INCLUDE,
      orderBy: [{ role: { type: 'asc' } }, { createdAt: 'asc' }],
    });

    const permissions = await getTeamPermissions(userId, teamId);
    if (permissions.canManageRoster) {
      return staff;
    }

    return staff.map(({ user, ...row }) => ({
      ...row,
      user: { id: user.id, name: user.name, isManaged: user.isManaged },
    }));
  }

  /**
   * Resolve the target user of a staff mutation from `{ userId }` or
   * `{ email }`. Never creates users: an unknown email is a 404.
   */
  private static async resolveStaffTarget(
    target: Pick<AddStaffInput, 'userId' | 'email'>
  ): Promise<{ id: string; name: string }> {
    const user = target.userId
      ? await prisma.user.findUnique({ where: { id: target.userId }, select: { id: true, name: true } })
      : await prisma.user.findFirst({
          where: { email: { equals: target.email, mode: 'insensitive' } },
          select: { id: true, name: true },
        });

    if (!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  }

  /** Find the team's default role row for a role type (e.g. HEAD_COACH). */
  private static async findRoleByType(teamId: string, roleType: StaffRoleType): Promise<TeamRole> {
    const role = await prisma.teamRole.findFirst({ where: { teamId, type: roleType } });
    if (!role) {
      throw new NotFoundError(`Role "${roleType}" not found for this team`);
    }
    return role;
  }

  /**
   * Throw if `staffUserId` is the team's only head coach. Used before any
   * change that would remove their HEAD_COACH row.
   */
  private static async assertNotLastHeadCoach(teamId: string, staffUserId: string): Promise<void> {
    const headCoaches = await prisma.teamStaff.findMany({
      where: { teamId, role: { type: 'HEAD_COACH' } },
      select: { userId: true },
    });
    const isHead = headCoaches.some((h) => h.userId === staffUserId);
    const distinctHeadCoaches = new Set(headCoaches.map((h) => h.userId)).size;
    if (isHead && distinctHeadCoaches <= 1) {
      throw new BadRequestError('Cannot remove the last Head Coach. Assign another Head Coach first.');
    }
  }

  /**
   * Add a staff member to a team with a default role type.
   * @param teamId Team ID
   * @param data `{ userId | email, roleType }` — existing users only
   * @param requestingUserId Must be a head coach, league admin or system admin
   */
  static async addStaffMember(
    teamId: string,
    data: AddStaffInput,
    requestingUserId: string
  ): Promise<TeamStaffWithRelations> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission (head coach / league admin / ADMIN — not assistants)
    const canManage = await canManageStaff(requestingUserId, teamId);
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }

    const user = await TeamService.resolveStaffTarget(data);
    const role = await TeamService.findRoleByType(teamId, data.roleType);

    // One role per user: existing staff must be re-roled via changeStaffRole
    const existingStaff = await prisma.teamStaff.findFirst({
      where: { teamId, userId: user.id },
    });

    if (existingStaff) {
      throw new BadRequestError('User is already a staff member of this team');
    }

    // Add staff member
    const teamStaff = await prisma.teamStaff.create({
      data: {
        teamId,
        userId: user.id,
        roleId: role.id,
      },
      include: TEAM_STAFF_INCLUDE,
    });

    // Best-effort push notification; never fails the request.
    try {
      await NotificationService.sendToUsers([user.id], {
        title: 'Added to team staff',
        body: `You were added to ${team.name} as ${role.name}`,
        data: { type: 'team_staff_added', teamId, roleType: role.type },
      });
    } catch (error) {
      logger.warn('Failed to send staff-added notification', {
        teamId,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return teamStaff;
  }

  /**
   * Change a staff member's role type.
   * @param requestingUserId Must be a head coach, league admin or system admin
   */
  static async changeStaffRole(
    teamId: string,
    staffUserId: string,
    roleType: StaffRoleType,
    requestingUserId: string
  ): Promise<TeamStaffWithRelations> {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const canManage = await canManageStaff(requestingUserId, teamId);
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }

    const current = await prisma.teamStaff.findFirst({
      where: { teamId, userId: staffUserId },
      include: { role: true },
    });
    if (!current) {
      throw new NotFoundError('User is not a staff member of this team');
    }

    const role = await TeamService.findRoleByType(teamId, roleType);
    if (current.roleId === role.id) {
      throw new BadRequestError('User already has this role on the team');
    }

    // Demoting the only head coach would leave the team unmanageable.
    if (current.role.type === 'HEAD_COACH') {
      await TeamService.assertNotLastHeadCoach(teamId, staffUserId);
    }

    return prisma.teamStaff.update({
      where: { id: current.id },
      data: { roleId: role.id },
      include: TEAM_STAFF_INCLUDE,
    });
  }

  /**
   * Remove a staff member (all of their roles) from a team.
   * Head coaches / league admins / system admins may remove anyone; any staff
   * member may remove THEMSELVES. The last head coach can never be removed.
   */
  static async removeStaffMember(
    teamId: string,
    staffUserId: string,
    requestingUserId: string
  ): Promise<{ success: true }> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission: self-removal is always allowed (subject to the guard)
    const isSelf = requestingUserId === staffUserId;
    if (!isSelf) {
      const canManage = await canManageStaff(requestingUserId, teamId);
      if (!canManage) {
        throw new ForbiddenError('You do not have permission to manage team staff');
      }
    }

    const existing = await prisma.teamStaff.findFirst({
      where: { teamId, userId: staffUserId },
    });
    if (!existing) {
      throw new NotFoundError('User is not a staff member of this team');
    }

    await TeamService.assertNotLastHeadCoach(teamId, staffUserId);

    await prisma.teamStaff.deleteMany({
      where: { teamId, userId: staffUserId },
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
   * Get all roles for a team (definitions only — see `listStaff` for holders)
   */
  static async getTeamRoles(teamId: string, userId: string): Promise<TeamRoleSummary[]> {
    // Check access
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const roles = await prisma.teamRole.findMany({
      where: { teamId },
      select: TEAM_ROLE_SELECT,
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

    // Managed user + team membership are created atomically: a failure on the
    // second insert must not leave an orphan managed user that belongs to no
    // roster and can't be reached through any team (audit #70).
    return prisma.$transaction(async (tx) => {
      const managedUser = await tx.user.create({
        data: {
          name: data.name,
          role: 'PLAYER',
          isManaged: true,
          managedById: userId,
          email: null,
          profilePictureUrl: data.profilePictureUrl,
        },
      });

      return tx.teamMember.create({
        data: {
          teamId,
          playerId: managedUser.id,
          jerseyNumber: data.jerseyNumber,
          position: data.position,
        },
        include: MANAGED_MEMBER_INCLUDE,
      });
    });
  }
}
