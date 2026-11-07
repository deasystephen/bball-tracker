/**
 * Team service layer for business logic
 */

import { Prisma, SubscriptionTier, TeamRole } from '@prisma/client';
import prisma from '../models';
import {
  CreateTeamInput,
  UpdateTeamInput,
  RolloverTeamInput,
  AddPlayerInput,
  UpdateTeamMemberInput,
  TeamQueryParams,
  AddStaffInput,
  StaffRoleType,
} from '../api/teams/schemas';
import { NotificationService } from './notification-service';
import { invalidateUsage } from './usage-service';
import { logger } from '../utils/logger';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  PaymentRequiredError,
  TeamSeasonExistsError,
  NotLatestSeasonError,
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
  lastHeadCoachTeams,
  readableTeamsWhere,
  canWriteLeague,
} from '../utils/permissions';
import { emailEquals } from '../utils/email-match';
import { USER_SUMMARY_WITH_EMAIL_SELECT } from '../utils/user-select';
import { createOrConflict, orNotFound } from '../utils/prisma-errors';
import { lockTeamRow } from '../utils/team-row-lock';
import { lockUsers } from '../utils/user-row-lock';
import { findOrCreateSeason, findSeasonIdByName } from './season-service';

const TEAM_SUMMARY_SELECT = {
  id: true,
  name: true,
} satisfies Prisma.TeamSelect;

const TEAM_STAFF_INCLUDE = {
  user: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
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
      player: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
    },
    orderBy: ROSTER_MEMBERS_ORDER_BY,
  },
} satisfies Prisma.TeamInclude;

/**
 * Roster rows on `GET /teams/:id` also carry the player's email delivery state
 * (#449) so a coach can be told "this address bounced". Deliberately NOT part
 * of USER_SUMMARY_WITH_EMAIL_SELECT: that select also feeds staff rows, which every team
 * member reads. Stripped with the email for callers without `canManageRoster`.
 */
const ROSTER_PLAYER_SELECT = {
  ...USER_SUMMARY_WITH_EMAIL_SELECT,
  emailSuppressedAt: true,
  emailSuppressedReason: true,
} satisfies Prisma.UserSelect;

const TEAM_DETAIL_INCLUDE = {
  ...TEAM_INCLUDE,
  members: {
    include: {
      player: { select: ROSTER_PLAYER_SELECT },
    },
    orderBy: ROSTER_MEMBERS_ORDER_BY,
  },
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
  player: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
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

/**
 * The role columns a rollover (#461) copies onto the new team-season: every
 * field but the ids, so custom roles keep their names and flags.
 */
const ROLLOVER_ROLE_SELECT = {
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
type RosterManagerOnlyField = 'email' | 'emailSuppressedAt' | 'emailSuppressedReason';
const ROSTER_MANAGER_ONLY_FIELDS: readonly RosterManagerOnlyField[] = ['email', 'emailSuppressedAt', 'emailSuppressedReason'];

/**
 * A roster player as seen by a caller without `canManageRoster`: removes only
 * the email and its delivery state, keeping every other selected field
 * (`isManaged`, `deletedAt` for tombstones). Shared by `GET /teams/:id` and
 * `GET /games/:id` so the two strips cannot drift (#642).
 */
export function omitRosterManagerFields<T extends { email: string | null }>(
  player: T
): Omit<T, RosterManagerOnlyField> {
  const publicPlayer: Record<string, unknown> = { ...player };
  for (const field of ROSTER_MANAGER_ONLY_FIELDS) {
    delete publicPlayer[field];
  }
  return publicPlayer as Omit<T, RosterManagerOnlyField>;
}
/**
 * `GET /teams/:id` payload. Member `player.email` and its delivery state
 * (`emailSuppressedAt` / `emailSuppressedReason`, #449) are present only when
 * the caller has `canManageRoster` on the team (audit #80); other callers get
 * the player without them (`omitRosterManagerFields`).
 */
export type TeamDetailView = Omit<TeamDetail, 'members'> & {
  /**
   * Whether this row is its lineage's latest team-season (#461,
   * `latestTeamSeasonId`): only that row may start the next season, so the
   * client offers "Start next season" only when this is true.
   */
  isLatestInLineage: boolean;
  members: Array<
    Omit<TeamDetailMember, 'player'> & {
      player: Omit<TeamDetailMember['player'], RosterManagerOnlyField> &
        Partial<Pick<TeamDetailMember['player'], RosterManagerOnlyField>>;
    }
  >;
};
export type TeamListItem = Prisma.TeamGetPayload<{ include: typeof TEAM_LIST_INCLUDE }>;
export type TeamMemberWithRelations = Prisma.TeamMemberGetPayload<{
  include: typeof TEAM_MEMBER_INCLUDE;
}>;
export type TeamStaffWithRelations = Prisma.TeamStaffGetPayload<{
  include: typeof TEAM_STAFF_INCLUDE;
}>;
export type TeamRoleSummary = Prisma.TeamRoleGetPayload<{ select: typeof TEAM_ROLE_SELECT }>;

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
 * WHY THERE IS NO P2002 RETRY. Prisma compiles all three upserts below to a
 * native `INSERT ... ON CONFLICT DO UPDATE`, so two concurrent provisionings
 * for one user converge on one league and one season without any retry
 * (`tests/integration/team-create.db.test.ts`, #765). This also runs inside
 * `createTeam`'s transaction, AFTER the `SELECT ... FOR UPDATE` on the
 * caller's own User row: that lock serializes the tier-cap re-check and this
 * provisioning per caller, and keeps it safe if an upsert ever loses the
 * native path (a nested write does that). Never add a P2002 retry, and do not
 * remove the lock. (A system ADMIN creating a same-named season in someone's
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
  // a coach carries the roster into a new season with `rolloverTeam` (#461).
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

/**
 * The tier team-cap re-check, run inside a transaction that has already taken
 * `SELECT ... FOR UPDATE` on the caller's own User row, so concurrent team
 * creates by one caller serialize and the route middleware's check-then-act
 * race cannot exceed the cap (audit #49). Used by `createTeam` only: a season
 * rollover continues a lineage, which the cap does not count (#461). System
 * admins bypass; unlimited tiers (every tier
 * since #445) skip the count, so this only does work once a finite `maxTeams`
 * is put back in `USAGE_LIMITS`.
 */
async function assertUnderTeamCap(
  tx: Prisma.TransactionClient,
  userId: string,
  user: { role: string; subscriptionTier: SubscriptionTier | null; subscriptionExpiresAt: Date | null }
): Promise<void> {
  if (user.role === 'ADMIN') {
    return;
  }
  const tier = getEffectiveTier({
    subscriptionTier: user.subscriptionTier ?? 'FREE',
    subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
  });
  if (getUsageLimits(tier).maxTeams === Infinity) {
    return;
  }
  const teamCount = await countDistinctStaffTeams(userId, tx);
  if (!canCreateTeam(tier, teamCount)) {
    throw new PaymentRequiredError({
      feature: featureCode(Feature.UNLIMITED_TEAMS),
      currentTier: tier,
      requiredTier: getRequiredTier(Feature.UNLIMITED_TEAMS),
    });
  }
}

/** What a rollover (#461) reads from the source team-season behind its row lock. */
const ROLLOVER_SOURCE_SELECT = {
  name: true,
  seasonId: true,
  season: { select: { leagueId: true } },
  lineageId: true,
  chatLink: true,
  ageGroup: true,
  gender: true,
  roles: { select: ROLLOVER_ROLE_SELECT },
  staff: {
    where: { user: { deletedAt: null } },
    select: { userId: true, role: { select: { name: true } } },
  },
  members: {
    where: { player: { deletedAt: null } },
    select: { playerId: true, jerseyNumber: true, position: true },
  },
} satisfies Prisma.TeamSelect;

/**
 * The id of the LATEST team-season of a lineage (#461): the one whose season
 * starts last, using the season's `startDate` and, for a season without one
 * (personal-league seasons have none), its `createdAt`; ties go to the
 * newer team row, then the larger id, so the answer is deterministic. Only
 * this row may start the next season (`rolloverTeam`), and the mobile team
 * screen offers "Start next season" only on it (`isLatestInLineage`).
 */
export async function latestTeamSeasonId(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  lineageId: string
): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM "Team" t
    JOIN "Season" s ON s."id" = t."seasonId"
    WHERE t."lineageId" = ${lineageId}
    ORDER BY COALESCE(s."startDate", s."createdAt") DESC, t."createdAt" DESC, t."id" DESC
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** 400 body for a season move that would put two rows of one lineage in one season. */
export const SEASON_SIBLING_MESSAGE = 'This team already has a row in that season';

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
    // (audit #70). A tier's team cap is re-checked inside the same transaction
    // behind a row lock on the user, so concurrent creates serialize and the
    // check-then-act race in the route middleware can't exceed the cap
    // (audit #49). Admins bypass; unlimited tiers skip the count — which is
    // every tier since #445, so the branch below only runs once a finite
    // `maxTeams` is put back in `USAGE_LIMITS`.
    //
    // Personal-league provisioning happens inside this same transaction and
    // AFTER the cap check, so a capped user never leaves a stray league behind.
    const team = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

      if (user) {
        await assertUnderTeamCap(tx, userId, user);
      }

      const seasonId =
        data.seasonId ?? (await resolvePersonalSeasonId(tx, userId, user?.name ?? 'My'));

      // Persistent identity across seasons (#462): every new team starts its
      // own lineage. Rollover (#461) / adoption (#459) reuse an existing one.
      // Two statements rather than a nested create so the team insert can keep
      // its unchecked scalar `seasonId` (Prisma won't mix scalar FKs with
      // nested relation writes in one payload).
      const lineage = await tx.teamLineage.create({ data: {}, select: { id: true } });

      const created = await tx.team.create({
        data: {
          name: data.name,
          seasonId,
          lineageId: lineage.id,
          chatLink: data.chatLink,
          ageGroup: data.ageGroup,
          gender: data.gender,
        },
      });

      await createDefaultTeamRoles(created.id, tx);
      await assignTeamRole(created.id, userId, 'Head Coach', tx);

      return created;
    });

    logger.info('Team created', {
      teamId: team.id,
      seasonId: team.seasonId,
      lineageId: team.lineageId,
      personalLeague: !data.seasonId,
      userId,
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
    const [permissions, latestId] = await Promise.all([
      getTeamPermissions(userId, teamId),
      latestTeamSeasonId(prisma, team.lineageId),
    ]);
    const isLatestInLineage = latestId === team.id;
    if (permissions.canManageRoster) {
      // Per the unification spec, the payload carries invite statuses for
      // ROSTERED players only; case-3 (existing-account, not-yet-member)
      // invites come from GET /invitations?teamId= client-side (red-team RT7).
      const memberIds = new Set(team.members.map((m) => m.playerId));
      return {
        ...team,
        isLatestInLineage,
        invitations: team.invitations.filter((inv) => memberIds.has(inv.playerId)),
      };
    }

    return {
      ...team,
      isLatestInLineage,
      invitations: [],
      members: team.members.map(({ player, ...member }) => ({
        ...member,
        player: omitRosterManagerFields(player),
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
      // Shared with the league-access predicates in `utils/permissions` so the
      // two definitions of "teams this caller may see" can never drift.
      conditions.push(await readableTeamsWhere(userId));
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

      // A lineage appears at most once per season (`@@unique([lineageId,
      // seasonId])`, what makes rollover idempotent). After #461 a lineage has
      // one row per season, so moving this row into a season that already
      // holds its sibling must be a 400, not a P2002 500. The insert below
      // maps a lost race to the same message.
      const sibling = await prisma.team.findFirst({
        where: { lineageId: team.lineageId, seasonId: data.seasonId, NOT: { id: teamId } },
        select: { id: true },
      });
      if (sibling) {
        throw new BadRequestError(SEASON_SIBLING_MESSAGE);
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

    // Per-season attributes; `null` clears (same rule as jersey/position on
    // `updateTeamMemberSchema`), absent leaves unchanged.
    if (data.ageGroup !== undefined) {
      updateData.ageGroup = data.ageGroup;
    }

    if (data.gender !== undefined) {
      updateData.gender = data.gender;
    }

    // Columns whose value actually changes, for the domain event: never the
    // values, and not a key the payload merely repeats (#686).
    const loaded: Record<string, unknown> = team;
    const fields = Object.entries(updateData)
      .filter(([key, value]) => value !== loaded[key])
      .map(([key]) => key);

    // Update the team
    try {
      const updated = await prisma.team.update({
        where: { id: teamId },
        data: updateData,
        include: TEAM_INCLUDE,
      });
      // A season move is a lineage-level change and gets its own line; a
      // rollover (#461) logs `Team rolled over` from `rolloverTeam`.
      const seasonMoved = data.seasonId !== undefined && data.seasonId !== team.seasonId;
      if (seasonMoved) {
        logger.info('Team moved to season', {
          teamId,
          lineageId: team.lineageId,
          fromSeasonId: team.seasonId,
          toSeasonId: data.seasonId,
          fields,
          userId,
        });
      } else {
        logger.info('Team updated', { teamId, fields, userId });
      }
      // A season move changes the `seasons` usage metric of every staff member
      // (#658); any other edit changes no metered count. `invalidateUsage`
      // dedupes a user holding two roles. Best-effort, never throws.
      if (seasonMoved) {
        await invalidateUsage(...updated.staff.map((s) => s.userId));
      }
      return updated;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestError(SEASON_SIBLING_MESSAGE);
      }
      throw err;
    }
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

    // Delete the team (cascade handles members, staff, roles and games), then
    // its lineage if this was the last team-season on it. Season/League
    // cascades bypass this path and leave harmless orphan lineages; this is
    // the only cleanup (#462).
    // The staff rows go with the team, so every staff member's usage counts
    // change (#658): read them inside the transaction, before the cascade.
    const { lineageDeleted, staffRows } = await prisma.$transaction(async (tx) => {
      const staffRows = await tx.teamStaff.findMany({
        where: { teamId },
        select: { userId: true },
      });

      await tx.team.delete({
        where: { id: teamId },
      });

      const remaining = await tx.team.count({ where: { lineageId: team.lineageId } });
      if (remaining === 0) {
        await tx.teamLineage.delete({ where: { id: team.lineageId } });
      }
      return { lineageDeleted: remaining === 0, staffRows };
    });

    // After commit: every staff member's counts changed, and the caller's may
    // have (#658). `invalidateUsage` dedupes; best-effort, never throws.
    await invalidateUsage(userId, ...staffRows.map((s) => s.userId));

    logger.info('Team deleted', {
      teamId,
      seasonId: team.seasonId,
      lineageId: team.lineageId,
      lineageDeleted,
      userId,
    });

    return { success: true };
  }

  /**
   * Start the next season of a team (#461): a NEW `Team` row in the target
   * season with the same `lineageId`, carrying the roster (jersey and
   * position), every role (custom ones included) and every staff row.
   *
   * Deliberately NOT carried: pending invitations (the new row starts with
   * none; Add Player re-invites), calendar feed tokens (a subscription stays
   * on the season it was issued for), announcements, games, stats and
   * competition entries (#492). Guardians attach to the child, not the team,
   * so they need nothing. Deleted accounts (tombstones, #444) are not carried.
   * The source row is left untouched and stays listed: its games and stats
   * are last season's, and the player career view reads them from it.
   *
   * Authorization: WHO is `canManageStaff` on the source team (head coach,
   * league admin, system admin; an assistant coach may not, same as a season
   * move), checked first and again behind the team row lock. WHERE is implied:
   * the target season must be in the source team's own league, and every
   * caller who passes `canManageStaff` there already passes `canWriteLeague`
   * (a league admin directly, a head coach as staff on a team in that league,
   * a system admin always), so a separate `canWriteLeague` call could never
   * refuse. Creating a season additionally needs `isLeagueAdmin`, the
   * `POST /seasons` rule: a staff member in a club league may roll into a
   * season the club made, never mint one. A `seasonId` in another league
   * answers the same 404 as an unknown one, so season ids cannot be probed.
   * Moving between clubs is adoption (#459).
   *
   * Only the lineage's LATEST team-season (`latestTeamSeasonId`: latest season
   * start, `createdAt` standing in for a missing `startDate`, then newest row)
   * may start the next season; any other row answers 409 `not_latest_season`
   * with no ids. Otherwise a coach removed from this season could roll last
   * season's row, where they were still head coach, forward and come back.
   *
   * A named season matches an existing one on `lower(trim(name))`
   * (`findSeasonIdByName`, shared with every season create path), so
   * "spring 2025" finds "Spring 2025" instead of minting a near-duplicate. A
   * new one is created through `findOrCreateSeason`, the same helper as
   * `POST /seasons`: League row lock, `ON CONFLICT DO NOTHING`, and the
   * `Season created` domain event.
   *
   * Not metered: the tier team cap counts LINEAGES (`countDistinctStaffTeams`),
   * so a rollover adds no team to anyone's count, the caller's or a carried
   * coach's, and is not behind `requireTeamCreateLimit`. Counting team-season
   * rows would charge a coach for every past season, and a capped coach could
   * never continue their own team.
   *
   * Locks, in order, all inside one transaction:
   *   1. every User the copy will reference (caller, staff, players), in id
   *      order (`lockUsers`, `FOR NO KEY UPDATE`, which conflicts with account
   *      deletion's `FOR UPDATE`). Deletion locks Users, then Teams; the copy's
   *      FK inserts need a share lock on every carried User, so taking them
   *      before the team keeps the order the same and the two never deadlock.
   *      The ids come from an unlocked read; anyone added between that read
   *      and the lock is simply not carried, and anyone deleted is dropped
   *      because only locked, live (`deletedAt` null) users are carried.
   *   2. the source Team row (`lockTeamRow`, the lock staff removals and role
   *      changes take); `canManageStaff` is re-checked through the
   *      transaction behind it, and the source is re-read, so a staff edit,
   *      season move or delete is seen whole (a deleted source is 404).
   *   3. the lineage (`FOR NO KEY UPDATE`), so two rollovers of one lineage
   *      serialize; a picked season is then share-locked (`FOR KEY SHARE`)
   *      and re-checked (gone or in another league: the same 404).
   *   4. the League row, only when a season is created (`findOrCreateSeason`).
   *
   * Order behind the locks: the existing row in the target season is the
   * answer if there is one (idempotent, even from last season's row); only
   * then does the latest-row rule apply, before any season is created.
   *
   * Idempotent: `@@unique([lineageId, seasonId])` holds one row per lineage
   * per season. When the lineage already has a row in the target season,
   * nothing is written and that row is returned with `created: false`, but
   * only to a caller who may manage its roster; anyone else gets 409
   * `team_season_exists` with no id (the source-team check says nothing about
   * the other row).
   * A P2002 on that unique (a concurrent season move into the same season)
   * answers the season move's 400; any other P2002 propagates.
   */
  static async rolloverTeam(
    teamId: string,
    data: RolloverTeamInput,
    userId: string
  ): Promise<{ team: TeamWithRelations; created: boolean }> {
    const preview = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, lineageId: true, season: { select: { leagueId: true } } },
    });

    if (!preview) {
      throw new NotFoundError('Team not found');
    }

    // WHO.
    if (!(await canManageStaff(userId, teamId))) {
      throw new ForbiddenError('Only a head coach can start the next season for this team');
    }

    const leagueId = preview.season.leagueId;

    // Resolve the target season (by id, or by name within the team's league).
    let targetSeasonId: string | null = null;
    if (data.seasonId) {
      const season = await prisma.season.findUnique({
        where: { id: data.seasonId },
        select: { id: true, leagueId: true },
      });
      // Another league's season answers exactly like a missing one.
      if (!season || season.leagueId !== leagueId) {
        throw new NotFoundError('Season not found');
      }
      targetSeasonId = season.id;
    } else {
      targetSeasonId = await findSeasonIdByName(prisma, leagueId, data.seasonName as string);
      if (!targetSeasonId && !(await isLeagueAdmin(userId, leagueId))) {
        throw new ForbiddenError('You do not have permission to create seasons for this league');
      }
    }

    // WHERE is implied (see above): the target season is in the source
    // team's own league, and `canManageStaff` there implies `canWriteLeague`.

    const result = await createOrConflict(
      () =>
        prisma.$transaction(async (tx) => {
          // 1. Users before the team (see the lock order above). Unlocked read
          // of who would be carried, then lock them all in id order.
          const candidates = await tx.team.findUnique({
            where: { id: teamId },
            select: { staff: { select: { userId: true } }, members: { select: { playerId: true } } },
          });
          if (!candidates) {
            throw new NotFoundError('Team not found');
          }
          const locked = await lockUsers(tx, [
            userId,
            ...candidates.staff.map((row) => row.userId),
            ...candidates.members.map((row) => row.playerId),
          ]);
          const liveUserIds = new Set(locked.filter((user) => user.deletedAt === null).map((user) => user.id));

          // 2. The source team, then WHO again behind its lock.
          if (!(await lockTeamRow(tx, teamId))) {
            throw new NotFoundError('Team not found');
          }
          if (!(await canManageStaff(userId, teamId, tx))) {
            throw new ForbiddenError('Only a head coach can start the next season for this team');
          }

          // 3. The lineage, so rollovers of one team serialize.
          await tx.$queryRaw`SELECT "id" FROM "TeamLineage" WHERE "id" = ${preview.lineageId} FOR NO KEY UPDATE`;

          // Re-read behind the lock: a season move or rename that committed
          // since the pre-checks is what this rollover continues from.
          const source = await tx.team.findUniqueOrThrow({
            where: { id: teamId },
            select: ROLLOVER_SOURCE_SELECT,
          });

          // Every check above ran against the league read before the lock; a
          // season move into another league since then voids them.
          if (source.season.leagueId !== leagueId) {
            throw new BadRequestError('This team moved to another league; reload it and try again');
          }

          // The target season, if it exists yet. A picked one is re-checked
          // behind a share lock: a delete or a move to another league since
          // the pre-check answers the same 404, and the lock holds it against
          // a delete until this commits. A named one is only looked up here;
          // it is created below, after the latest-row rule.
          let seasonId: string | null;
          if (targetSeasonId) {
            const [season] = await tx.$queryRaw<{ leagueId: string }[]>`
              SELECT "leagueId" FROM "Season" WHERE "id" = ${targetSeasonId} FOR KEY SHARE`;
            if (!season || season.leagueId !== leagueId) {
              throw new NotFoundError('Season not found');
            }
            seasonId = targetSeasonId;
          } else {
            seasonId = await findSeasonIdByName(tx, leagueId, data.seasonName as string);
          }

          if (seasonId === source.seasonId) {
            throw new BadRequestError('The team is already in that season');
          }

          // Idempotent: the lineage's row in that season, if any, is the
          // answer (a repeated tap from last season's screen lands here). It
          // is returned in full only to a caller who may manage it; see below.
          if (seasonId) {
            const existing = await tx.team.findUnique({
              where: { lineageId_seasonId: { lineageId: source.lineageId, seasonId } },
              select: { id: true },
            });
            if (existing) {
              return {
                teamId: existing.id,
                created: false,
                seasonId,
                seasonCreated: false,
                fromSeasonId: source.seasonId,
                members: 0,
                staffUserIds: [] as string[],
              };
            }
          }

          // Only the lineage's latest team-season continues it, so a coach
          // removed from this season cannot roll last season's row forward
          // and come back as head coach.
          if ((await latestTeamSeasonId(tx, preview.lineageId)) !== teamId) {
            throw new NotLatestSeasonError();
          }

          // 4. A named season that does not exist yet goes through the one
          // season-create path (League lock, name match ignoring case,
          // ON CONFLICT DO NOTHING, the `Season created` event).
          let seasonCreated = false;
          if (!seasonId) {
            const season = await findOrCreateSeason(tx, { leagueId, name: data.seasonName as string }, userId);
            seasonId = season.id;
            seasonCreated = season.created;
          }
          const targetId: string = seasonId;

          const created = await tx.team.create({
            data: {
              name: data.name ?? source.name,
              seasonId: targetId,
              lineageId: source.lineageId,
              chatLink: source.chatLink,
              ageGroup: data.ageGroup !== undefined ? data.ageGroup : source.ageGroup,
              gender: data.gender !== undefined ? data.gender : source.gender,
            },
            select: { id: true },
          });

          // Roles first (custom ones too, with their flags); staff then point
          // at the new role ids by name (`@@unique([teamId, name])`).
          const newRoles = await tx.teamRole.createManyAndReturn({
            data: source.roles.map((role) => ({ ...role, teamId: created.id })),
            select: { id: true, name: true },
          });
          const roleIdByName = new Map(newRoles.map((role) => [role.name, role.id]));

          // Only users locked in step 1 and still live are carried.
          const carriedStaff = source.staff.filter((row) => liveUserIds.has(row.userId));
          const carriedMembers = source.members.filter((row) => liveUserIds.has(row.playerId));

          const staffRows = carriedStaff.map((row) => {
            const roleId = roleIdByName.get(row.role.name);
            if (!roleId) {
              // Every role was just copied, so this is a broken invariant:
              // fail the whole rollover rather than ship a team without them.
              throw new Error('Rollover could not map a staff role onto the new team');
            }
            return { teamId: created.id, userId: row.userId, roleId };
          });
          if (staffRows.length > 0) {
            await tx.teamStaff.createMany({ data: staffRows });
          }

          if (carriedMembers.length > 0) {
            await tx.teamMember.createMany({
              data: carriedMembers.map((member) => ({ ...member, teamId: created.id })),
            });
          }

          return {
            teamId: created.id,
            created: true,
            seasonId,
            seasonCreated,
            fromSeasonId: source.seasonId,
            members: carriedMembers.length,
            staffUserIds: staffRows.map((row) => row.userId),
          };
        }),
      SEASON_SIBLING_MESSAGE,
      { anyOf: ['Team_lineageId_seasonId_key', ['lineageId', 'seasonId']] }
    );

    logger.info('Team rolled over', {
      teamId: result.teamId,
      fromTeamId: teamId,
      lineageId: preview.lineageId,
      fromSeasonId: result.fromSeasonId,
      toSeasonId: result.seasonId,
      created: result.created,
      seasonCreated: result.seasonCreated,
      members: result.members,
      staff: result.staffUserIds.length,
      userId,
    });

    if (result.created) {
      // Every carried staff member is now staff on one more team in one more
      // season (#658 usage metrics). Best-effort, never throws.
      await invalidateUsage(userId, ...result.staffUserIds);
    } else if (!(await hasTeamPermission(userId, result.teamId, 'canManageRoster'))) {
      // The lineage's row in that season is not the caller's to read
      // (`canManageRoster` implies access). Say it exists, name nothing.
      throw new TeamSeasonExistsError();
    }

    const team = await prisma.team.findUnique({
      where: { id: result.teamId },
      include: TEAM_INCLUDE,
    });
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    return { team, created: result.created };
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

    // Add player to team; a lost race on @@unique([teamId, playerId]) answers
    // the pre-check's 400 (#727).
    const teamMember = await createOrConflict(
      () =>
        prisma.teamMember.create({
          data: {
            teamId,
            playerId: data.playerId,
            jerseyNumber: data.jerseyNumber,
            position: data.position,
          },
          include: TEAM_MEMBER_INCLUDE,
        }),
      'Player is already on this team',
      'TeamMember_teamId_playerId_key'
    );

    logger.info('Roster player added', { teamId, playerId: data.playerId, userId, via: 'existing-user' });

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

    logger.info('Roster player removed', { teamId, playerId, userId });

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

    logger.info('Roster member updated', { teamId, playerId, userId });

    return updatedMember;
  }

  /**
   * List a team's staff (every role assignment) with user + role.
   * Any team member/staff/admin may read, and every reader gets the staff
   * emails (coach contact info), as on `GET /teams/:id` and `GET /games/:id`
   * (CLAUDE.md, emails in payloads; #683).
   */
  static async listStaff(teamId: string, userId: string): Promise<TeamStaffWithRelations[]> {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    return prisma.teamStaff.findMany({
      where: { teamId },
      include: TEAM_STAFF_INCLUDE,
      orderBy: [{ role: { type: 'asc' } }, { createdAt: 'asc' }],
    });
  }

  /**
   * Resolve the target user of a staff mutation from `{ userId }` or
   * `{ email }`. Never creates users: an unknown email is a 404.
   */
  private static async resolveStaffTarget(
    target: Pick<AddStaffInput, 'userId' | 'email'>
  ): Promise<{ id: string; name: string }> {
    let user: { id: string; name: string } | null = null;
    if (target.userId) {
      user = await prisma.user.findUnique({
        where: { id: target.userId, deletedAt: null },
        select: { id: true, name: true },
      });
    } else if (target.email) {
      // Never build the filter from a missing email: Prisma drops an
      // `undefined` condition, and the lookup would match the first user.
      user = await prisma.user.findFirst({
        where: { email: emailEquals(target.email), deletedAt: null },
        select: { id: true, name: true },
      });
    }

    if (!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  }

  /** Find the team's default role row for a role type (e.g. HEAD_COACH). */
  private static async findRoleByType(
    teamId: string,
    roleType: StaffRoleType,
    db: Prisma.TransactionClient = prisma
  ): Promise<TeamRole> {
    const role = await db.teamRole.findFirst({ where: { teamId, type: roleType } });
    if (!role) {
      throw new NotFoundError(`Role "${roleType}" not found for this team`);
    }
    return role;
  }

  /**
   * Throw if `staffUserId` is the team's only head coach. Used before any
   * change that would remove their HEAD_COACH row.
   */
  private static async assertNotLastHeadCoach(
    teamId: string,
    staffUserId: string,
    db: Prisma.TransactionClient
  ): Promise<void> {
    // Shared rule with account deletion (#444) — see utils/permissions.
    const blocking = await lastHeadCoachTeams(staffUserId, db, { teamIds: [teamId] });
    if (blocking.length > 0) {
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
    const existingStaff = await prisma.teamStaff.findUnique({
      where: { teamId_userId: { teamId, userId: user.id } },
      select: { id: true },
    });

    if (existingStaff) {
      throw new BadRequestError('User is already a staff member of this team');
    }

    // Add staff member; a lost race on @@unique([teamId, userId]) answers the
    // pre-check's 400 (#727). The index is one role per user per team (#463),
    // so a concurrent add with a different role is refused too. The retired
    // [teamId, userId, roleId] name is accepted as well, for a database still
    // carrying it (the #463 migration not yet applied, or applied part-way).
    const teamStaff = await createOrConflict(
      () =>
        prisma.teamStaff.create({
          data: {
            teamId,
            userId: user.id,
            roleId: role.id,
          },
          include: TEAM_STAFF_INCLUDE,
        }),
      'User is already a staff member of this team',
      { anyOf: ['TeamStaff_teamId_userId_key', 'TeamStaff_teamId_userId_roleId_key'] }
    );

    logger.info('Staff added', {
      teamId,
      staffUserId: user.id,
      roleType: role.type,
      userId: requestingUserId,
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
    // Everything runs behind the team row lock, so two concurrent demotions
    // (or a demotion and a removal) of a team's two head coaches cannot both
    // pass the last-head-coach guard (#463). Error precedence is unchanged:
    // team 404, then 403, then not-staff 404, then role 404, then same-role 400.
    // A waiter stuck behind the lock is cancelled by PostgreSQL at the
    // pool-wide lock_timeout (models/pool-config.ts, #934 → #944) and answers
    // the retryable 503, freeing its connection.
    const { current, updated } = await prisma.$transaction(async (tx) => {
      if (!(await lockTeamRow(tx, teamId))) {
        throw new NotFoundError('Team not found');
      }

      const canManage = await canManageStaff(requestingUserId, teamId);
      if (!canManage) {
        throw new ForbiddenError('You do not have permission to manage team staff');
      }

      const current = await tx.teamStaff.findUnique({
        where: { teamId_userId: { teamId, userId: staffUserId } },
        include: { role: true },
      });
      if (!current) {
        throw new NotFoundError('User is not a staff member of this team');
      }

      const role = await TeamService.findRoleByType(teamId, roleType, tx);
      if (current.roleId === role.id) {
        throw new BadRequestError('User already has this role on the team');
      }

      // Demoting the only head coach would leave the team unmanageable.
      if (current.role.type === 'HEAD_COACH') {
        await TeamService.assertNotLastHeadCoach(teamId, staffUserId, tx);
      }

      // Account deletion removes a non-head-coach's staff rows without this
      // lock (it locks only teams where the user is HEAD_COACH), so the row
      // can still vanish under us: the same 404 as the read, not a P2025 500.
      const updated = await orNotFound(
        () =>
          tx.teamStaff.update({
            where: { id: current.id },
            data: { roleId: role.id },
            include: TEAM_STAFF_INCLUDE,
          }),
        new NotFoundError('User is not a staff member of this team')
      );
      return { current, updated };
    });

    logger.info('Staff role changed', {
      teamId,
      staffUserId,
      fromRoleType: current.role.type,
      roleType: updated.role.type,
      userId: requestingUserId,
    });

    return updated;
  }

  /**
   * Remove a staff member (their one staff row) from a team.
   * Head coaches / league admins / system admins may remove anyone; any staff
   * member may remove THEMSELVES. The last head coach can never be removed.
   */
  static async removeStaffMember(
    teamId: string,
    staffUserId: string,
    requestingUserId: string
  ): Promise<{ success: true }> {
    const isSelf = requestingUserId === staffUserId;

    // Everything runs behind the team row lock, so two concurrent removals
    // (or a removal and a demotion) of a team's two head coaches cannot both
    // pass the last-head-coach guard (#463). Error precedence is unchanged:
    // team 404, then 403, then not-staff 404, then last-head-coach 400.
    // A waiter stuck behind the lock is cancelled by PostgreSQL at the
    // pool-wide lock_timeout (models/pool-config.ts, #934 → #944) and answers
    // the retryable 503, freeing its connection.
    const removed = await prisma.$transaction(async (tx) => {
      if (!(await lockTeamRow(tx, teamId))) {
        throw new NotFoundError('Team not found');
      }

      // Self-removal is always allowed (subject to the guard).
      if (!isSelf) {
        const canManage = await canManageStaff(requestingUserId, teamId);
        if (!canManage) {
          throw new ForbiddenError('You do not have permission to manage team staff');
        }
      }

      const existing = await tx.teamStaff.findUnique({
        where: { teamId_userId: { teamId, userId: staffUserId } },
        include: { role: true },
      });
      if (!existing) {
        throw new NotFoundError('User is not a staff member of this team');
      }

      if (existing.role.type === 'HEAD_COACH') {
        await TeamService.assertNotLastHeadCoach(teamId, staffUserId, tx);
      }

      // Account deletion removes a non-head-coach's staff rows without this
      // lock, so the row can still vanish under us: 404, not a P2025 500.
      return orNotFound(
        () => tx.teamStaff.delete({ where: { id: existing.id } }),
        new NotFoundError('User is not a staff member of this team')
      );
    });

    logger.info('Staff removed', {
      teamId,
      staffUserId,
      roleId: removed.roleId,
      self: isSelf,
      userId: requestingUserId,
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

    // Create the role; a lost race on @@unique([teamId, name]) answers the
    // pre-check's 400 (#727).
    const role = await createOrConflict(
      () =>
        prisma.teamRole.create({
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
        }),
      'A role with this name already exists',
      'TeamRole_teamId_name_key'
    );

    logger.info('Custom role created', { teamId, roleId: role.id, userId: requestingUserId });

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
}
