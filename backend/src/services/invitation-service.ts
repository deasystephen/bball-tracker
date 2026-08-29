/**
 * Invitation service layer for business logic
 */

import { Prisma, TeamInvitation, TeamMember } from '@prisma/client';
import prisma from '../models';
import {
  CreateInvitationInput,
  InvitationQueryParams,
} from '../api/invitations/schemas';
import { AddRosterPlayerInput } from '../api/teams/schemas';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  AppError,
} from '../utils/errors';
import { randomBytes } from 'crypto';
import {
  hasTeamPermission,
  canAccessTeam,
  isSystemAdmin,
  getPlayerTeamAccess,
  isGuardianOf,
} from '../utils/permissions';
import { GuardianService } from './guardian-service';
import { mailer } from './mailer';
import { invitationTemplate } from './mailer/templates';
import { logger } from '../utils/logger';
import { formatEmailDate } from '../utils/format-date';
import { withTimeout } from '../utils/promise-timeout';

/**
 * Awaited email sends live in request paths so `emailSent` can be reported;
 * this cap keeps a degraded SES from holding requests for the SDK's full
 * retry budget, and keeps route latency safely under the production mobile
 * client's 10s axios timeout (pre-landing review, performance + api-contract
 * specialists).
 */
const EMAIL_SEND_TIMEOUT_MS = 5_000;

/** Default invitation lifetime — single source for every creation path (the
 * Zod schema's expiresInDays default mirrors it). */
const DEFAULT_INVITATION_EXPIRES_DAYS = 7;

/** One shape for invitation birth — every creation path builds its row here so
 * a future field cannot be added to only some paths (maintainability). */
function buildInvitationData(params: {
  teamId: string;
  playerId: string;
  invitedById: string;
  token: string;
  expiresAt: Date;
  jerseyNumber?: number;
  position?: string;
  message?: string;
}): Prisma.TeamInvitationUncheckedCreateInput {
  return {
    teamId: params.teamId,
    playerId: params.playerId,
    invitedById: params.invitedById,
    token: params.token,
    jerseyNumber: params.jerseyNumber,
    position: params.position,
    message: params.message,
    expiresAt: params.expiresAt,
    status: 'PENDING',
  };
}

/**
 * Thrown inside the case-2 transaction when the target account was claimed
 * (WorkOS signup completed) between the pre-transaction read and the guarded
 * write — the caller re-branches to case 3 (red-team RT4).
 */
class ClaimedMidCreateError extends Error {
  constructor(public readonly playerId: string) {
    super('Account was claimed during roster add');
    this.name = 'ClaimedMidCreateError';
  }
}

function invitationExpiry(days: number = DEFAULT_INVITATION_EXPIRES_DAYS): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}

const USER_SUMMARY_SELECT = {
  id: true,
  name: true,
  email: true,
} satisfies Prisma.UserSelect;

/**
 * Scalar fields safe to return on authenticated responses.
 *
 * `token` is deliberately absent: it is a bearer secret that lets anyone call
 * the unauthenticated `POST /invitations/by-token/:token/accept`, so it must
 * only ever travel inside the invitation email (audit #14).
 */
const INVITATION_SCALAR_SELECT = {
  id: true,
  teamId: true,
  playerId: true,
  invitedById: true,
  status: true,
  jerseyNumber: true,
  position: true,
  message: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  acceptedAt: true,
  rejectedAt: true,
} satisfies Prisma.TeamInvitationSelect;

const INVITATION_SELECT = {
  ...INVITATION_SCALAR_SELECT,
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
  player: { select: USER_SUMMARY_SELECT },
  invitedBy: { select: USER_SUMMARY_SELECT },
} satisfies Prisma.TeamInvitationSelect;

const INVITATION_TEAM_SELECT = {
  ...INVITATION_SCALAR_SELECT,
  team: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.TeamInvitationSelect;

const ACCEPTED_MEMBER_INCLUDE = {
  player: { select: USER_SUMMARY_SELECT },
  team: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.TeamMemberInclude;

/** Invitation without its secret `token` (every authenticated response). */
export type InvitationSummary = Prisma.TeamInvitationGetPayload<{
  select: typeof INVITATION_SCALAR_SELECT;
}>;
export type InvitationWithRelations = Prisma.TeamInvitationGetPayload<{
  select: typeof INVITATION_SELECT;
}>;
export type InvitationWithTeam = Prisma.TeamInvitationGetPayload<{
  select: typeof INVITATION_TEAM_SELECT;
}>;
export type AcceptedTeamMember = Prisma.TeamMemberGetPayload<{
  include: typeof ACCEPTED_MEMBER_INCLUDE;
}>;

export interface InvitationList {
  invitations: InvitationWithRelations[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface AcceptInvitationResult {
  invitation: InvitationSummary;
  teamMember: AcceptedTeamMember;
}

/**
 * `createInvitation` result. `emailSent` is `null` when the invited player has
 * no email address; otherwise it reports whether the invitation email was
 * handed to the mailer successfully (roster/invite unification spec — a
 * silently failed send was invisible to coaches, SES-sandbox incident
 * 2026-08-28).
 */
export interface CreateInvitationResult {
  invitation: InvitationWithRelations;
  emailSent: boolean | null;
}

const ADDED_MEMBER_INCLUDE = {
  player: {
    select: {
      ...USER_SUMMARY_SELECT,
      isManaged: true,
      managedById: true,
    },
  },
  team: { select: { id: true, name: true } },
} satisfies Prisma.TeamMemberInclude;

export type AddedTeamMember = Prisma.TeamMemberGetPayload<{
  include: typeof ADDED_MEMBER_INCLUDE;
}>;

/**
 * `POST /teams/:teamId/players` (unified Add Player) result.
 *
 * - Cases 1-2 (no email / email without a claimed account): `rostered: true`,
 *   `member` set; case 2 also has `invitation` + `emails.player`.
 * - Case 3 (email belongs to a claimed account): `rostered: false`,
 *   `invitation` set — membership is created when the player accepts (consent
 *   model; auto-accept is deferred, decision D2).
 * - `guardianInvited` is true only when a `GuardianInvitation` was created
 *   (requires a roster entry, so never in case 3 — `guardianReason` explains).
 */
export interface AddRosterPlayerResult {
  rostered: boolean;
  invited: boolean;
  member: AddedTeamMember | null;
  invitation: InvitationSummary | null;
  guardianInvited: boolean;
  guardianReason?: string;
  emails: { player?: boolean; guardian?: boolean };
}

export interface AcceptInvitationByTokenResult {
  invitation: InvitationSummary;
  teamMember: TeamMember;
}

/** Limited, unauthenticated view of an invitation (public token lookup). */
export interface PublicInvitation {
  id: string;
  status: TeamInvitation['status'];
  teamName: string;
  inviterName: string;
  position: string | null;
  jerseyNumber: number | null;
  message: string | null;
  expiresAt: string;
}

export class InvitationService {
  /**
   * Generate a secure invitation token
   */
  private static generateToken(): string {
    // Generate 32-byte random token and convert to base64url
    return randomBytes(32).toString('base64url');
  }

  /**
   * Create a new team invitation.
   *
   * With `data.supersede` a live PENDING invitation for the player is expired
   * and replaced instead of answering 400 — this is how "Resend" works
   * (roster/invite unification spec: one write path for invitation birth, the
   * old link dies because the token is new).
   *
   * @param teamId Team ID
   * @param data Invitation data
   * @param userId User ID (must have canManageRoster permission)
   */
  static async createInvitation(
    teamId: string,
    data: CreateInvitationInput,
    userId: string
  ): Promise<CreateInvitationResult> {
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
      throw new ForbiddenError('You do not have permission to send invitations for this team');
    }

    const expiresAt = invitationExpiry(data.expiresInDays || DEFAULT_INVITATION_EXPIRES_DAYS);

    // Generate secure token
    const token = this.generateToken();

    const invitationData = (playerId: string): Prisma.TeamInvitationUncheckedCreateInput =>
      buildInvitationData({
        teamId,
        playerId,
        invitedById: userId,
        token,
        expiresAt,
        jerseyNumber: data.jerseyNumber,
        position: data.position,
        message: data.message,
      });

    let invitation: InvitationWithRelations;

    if (data.playerId) {
      // Invite an existing user
      const player = await prisma.user.findUnique({
        where: { id: data.playerId },
      });

      if (!player) {
        throw new NotFoundError('User not found');
      }

      await this.assertSupersedeTarget(teamId, player, data.supersede);

      invitation = data.supersede
        ? await this.createInvitationRowSuperseding(invitationData(player.id))
        : await this.createInvitationRow(invitationData(player.id));
    } else {
      // Create-and-invite (audit #69). `name` + `email` are guaranteed by the
      // schema. If the email already belongs to a user (e.g. a retry after a
      // partial failure, or a player who signed up on their own) reuse that
      // account instead of failing; otherwise create the user and the
      // invitation in ONE transaction so a failed invite leaves no orphan.
      // Two coaches racing the same new email both pass the findUnique — the
      // loser's create hits P2002 and retries once against the now-existing
      // row instead of surfacing a 500.
      // Emails are matched case-insensitively and stored lowercase: WorkOS
      // normalizes to lowercase, and syncUser claims by exact match, so a
      // mixed-case entry would create an unclaimable duplicate and bypass the
      // case-3 consent branch (red-team RT1).
      const email = (data.email as string).trim().toLowerCase();
      const name = data.name as string;

      const existingUser = await prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });

      if (existingUser) {
        await this.assertSupersedeTarget(teamId, existingUser, data.supersede);

        invitation = data.supersede
          ? await this.createInvitationRowSuperseding(invitationData(existingUser.id))
          : await this.createInvitationRow(invitationData(existingUser.id));
      } else {
        try {
          invitation = await prisma.$transaction(async (tx) => {
            const created = await tx.user.create({
              data: {
                name,
                email,
                role: 'PLAYER',
                emailVerified: false,
                profilePictureUrl: data.profilePictureUrl,
                // The creating coach manages this account until it is claimed
                // (chip derivation + B2.10 edit rights; unification spec T2).
                isManaged: true,
                managedById: userId,
              },
              select: { id: true },
            });

            return tx.teamInvitation.create({
              data: invitationData(created.id),
              select: INVITATION_SELECT,
            });
          });
        } catch (err) {
          const racedUser = await this.resolveEmailRaceWinner(email, err);
          await this.assertSupersedeTarget(teamId, racedUser, data.supersede);
          invitation = data.supersede
            ? await this.createInvitationRowSuperseding(invitationData(racedUser.id))
            : await this.createInvitationRow(invitationData(racedUser.id));
        }
      }
    }

    // A superseding resend for an already-rostered (case 2) player repeats the
    // "you've been added" framing, not "invited to join" (red-team RT6).
    let variant: 'invited' | 'added' = 'invited';
    if (data.supersede) {
      const member = await prisma.teamMember.findUnique({
        where: { teamId_playerId: { teamId, playerId: invitation.playerId } },
        select: { teamId: true },
      });
      if (member) {
        variant = 'added';
      }
    }
    const emailSent = await this.deliverInvitationEmail(invitation, token, variant);

    return { invitation, emailSent };
  }

  /**
   * Send the invitation email and report success. Failures are logged and
   * returned as `false`, never thrown — the invitation row is already
   * committed and usable in-app. Returns `null` when the player has no email.
   */
  private static async deliverInvitationEmail(
    invitation: InvitationWithRelations,
    token: string,
    variant: 'invited' | 'added'
  ): Promise<boolean | null> {
    if (!invitation.player.email) {
      return null;
    }

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://capyhoops.com';
    const acceptUrl = `${baseUrl}/invite/${token}`;
    try {
      await withTimeout(mailer.send({
        template: invitationTemplate,
        to: invitation.player.email,
        variables: {
          playerName: invitation.player.name ?? invitation.player.email,
          teamName: invitation.team.name,
          inviterName: invitation.invitedBy.name ?? invitation.invitedBy.email ?? '',
          message: invitation.message ?? '',
          expiresAt: formatEmailDate(invitation.expiresAt),
          acceptUrl,
          variant,
        },
        metadata: {
          userId: invitation.playerId,
          event_type: 'invitation.created',
          teamId: invitation.teamId,
          invitationId: invitation.id,
        },
      }), EMAIL_SEND_TIMEOUT_MS, 'invitation email send');
      return true;
    } catch (err: unknown) {
      logger.error('Failed to send invitation email', {
        error: err instanceof Error ? err.message : String(err),
        invitationId: invitation.id,
      });
      return false;
    }
  }

  /**
   * Create an invitation row outside a transaction, mapping a partial-unique
   * P2002 (another request created a PENDING row between our expiry check and
   * this insert — e.g. a double-tapped Resend) to the same 400 the dedupe
   * check answers, instead of a 500.
   */
  private static async createInvitationRow(
    data: Prisma.TeamInvitationUncheckedCreateInput
  ): Promise<InvitationWithRelations> {
    try {
      return await prisma.teamInvitation.create({
        data,
        select: INVITATION_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestError('A pending invitation already exists for this player');
      }
      throw err;
    }
  }

  /**
   * Atomic supersede (spec D4): expire the live PENDING row and create its
   * replacement in ONE transaction, so a failed create can never leave the
   * player with a dead link and no invitation (red-team RT2). An ACCEPTED row
   * appearing in the window means the player just accepted — refuse rather
   * than regress their chip to Invited.
   */
  private static async createInvitationRowSuperseding(
    data: Prisma.TeamInvitationUncheckedCreateInput
  ): Promise<InvitationWithRelations> {
    try {
      return await prisma.$transaction(async (tx) => {
        const accepted = await tx.teamInvitation.findFirst({
          where: { teamId: data.teamId, playerId: data.playerId, status: 'ACCEPTED' },
          select: { id: true },
        });
        if (accepted) {
          throw new BadRequestError('Player already has access to this team');
        }

        // A bare resend ({ playerId, supersede: true }) must not wipe the
        // jersey/position/message the coach set at add time: for invite-only
        // players (case 3) the roster row is born from the live invitation at
        // accept, so a superseding row created without them would roster the
        // player with no jersey (jersey-loss bug, 2026-08-29). Fields the
        // caller omits inherit from the row being superseded; explicitly
        // provided values still win.
        const superseded = await tx.teamInvitation.findFirst({
          where: { teamId: data.teamId, playerId: data.playerId, status: 'PENDING' },
          select: { jerseyNumber: true, position: true, message: true },
        });

        await tx.teamInvitation.updateMany({
          where: { teamId: data.teamId, playerId: data.playerId, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });

        return tx.teamInvitation.create({
          data: {
            ...data,
            jerseyNumber:
              data.jerseyNumber === undefined ? superseded?.jerseyNumber : data.jerseyNumber,
            position: data.position === undefined ? superseded?.position : data.position,
            message: data.message === undefined ? superseded?.message : data.message,
          },
          select: INVITATION_SELECT,
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestError('A pending invitation already exists for this player');
      }
      throw err;
    }
  }

  /**
   * The supersede guard trio, applied identically on every createInvitation
   * arm so the option set cannot drift per branch (pre-landing review,
   * maintainability specialist): an Active (claimed + rostered) member is
   * refused; otherwise a live PENDING row is expired when superseding, and a
   * rostered case-2 player is a legitimate target.
   */
  private static async assertSupersedeTarget(
    teamId: string,
    player: { id: string; workosUserId: string | null },
    supersede: boolean | undefined
  ): Promise<void> {
    if (supersede) {
      await this.assertNotActiveMember(teamId, player.id, player.workosUserId);
    }
    await this.assertInvitable(teamId, player.id, {
      supersede,
      allowExistingMember: supersede,
    });
  }

  /**
   * A unique-email race lost inside a create transaction: verify the error is
   * the P2002, refetch the winner row, rethrow when there is none.
   */
  private static async resolveEmailRaceWinner(
    email: string,
    err: unknown
  ): Promise<Prisma.UserGetPayload<Record<string, never>>> {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      throw err;
    }
    const racedUser = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!racedUser) {
      throw err;
    }
    return racedUser;
  }

  /**
   * A claimed account that is already a member is Active — inviting it again
   * (supersede path) is a coach mistake, not a resend.
   */
  private static async assertNotActiveMember(
    teamId: string,
    playerId: string,
    workosUserId: string | null
  ): Promise<void> {
    if (!workosUserId) {
      return;
    }
    const member = await prisma.teamMember.findUnique({
      where: { teamId_playerId: { teamId, playerId } },
    });
    if (member) {
      throw new BadRequestError('Player already has access to this team');
    }
  }

  /**
   * Reject when the player is already rostered or already has a live PENDING
   * invitation. A PENDING row whose expiresAt has passed is not a blocker:
   * mark it EXPIRED and carry on (audit #23 — nothing else ever flips expired
   * rows, so dedupe must).
   *
   * Options:
   * - `supersede`: a live PENDING invitation is expired instead of throwing —
   *   the "Resend" path (unification spec D4-as-amended).
   * - `allowExistingMember`: skip the roster check — the unified Add Player
   *   flow creates the membership and the invitation together, so the member
   *   row legitimately exists (or is about to).
   */
  private static async assertInvitable(
    teamId: string,
    playerId: string,
    options: { supersede?: boolean; allowExistingMember?: boolean } = {}
  ): Promise<void> {
    if (!options.allowExistingMember) {
      const existingMember = await prisma.teamMember.findUnique({
        where: {
          teamId_playerId: {
            teamId,
            playerId,
          },
        },
      });

      if (existingMember) {
        throw new BadRequestError('Player is already on this team');
      }
    }

    const existingInvitation = await prisma.teamInvitation.findFirst({
      where: {
        teamId,
        playerId,
        status: 'PENDING',
      },
    });

    if (existingInvitation) {
      const live = existingInvitation.expiresAt.getTime() > Date.now();
      if (live && !options.supersede) {
        throw new BadRequestError('A pending invitation already exists for this player');
      }
      if (!live) {
        // Stale row: lazy-expire (the old link is already dead, so this being
        // a separate statement loses nothing).
        await this.markExpired(existingInvitation.id);
      }
      // live + supersede: left PENDING — createInvitationRowSuperseding
      // expires it in the same transaction as the replacement (red-team RT2).
    }
  }

  /**
   * List invitations with optional filters
   * @param params Query parameters
   * @param userId User ID (for authorization)
   */
  static async listInvitations(
    params: InvitationQueryParams,
    userId: string
  ): Promise<InvitationList> {
    const { status, teamId, playerId, limit, offset } = params;

    // Build where clause
    const where: Prisma.TeamInvitationWhereInput = {};

    if (status) {
      where.status = status;
    }

    // Staff who can manage the roster see every invitation for the team
    // (pending, rejected, expired, ...). Anyone else with team access (a
    // rostered player) is scoped to their own rows, as before (audit #23).
    let scopeToCaller = true;

    if (teamId) {
      // Verify user has access to this team
      const hasAccess = await canAccessTeam(userId, teamId);
      if (!hasAccess) {
        throw new ForbiddenError('You do not have access to this team\'s invitations');
      }

      where.teamId = teamId;
      scopeToCaller = !(await hasTeamPermission(userId, teamId, 'canManageRoster'));
    }

    if (playerId) {
      // Another player's invitations are visible to system ADMINs, to the
      // player's guardians (PARENT role), to roster managers of the requested
      // team, or — with no teamId — to roster managers of a team that player
      // is on, scoped to those teams. The self-selected global COACH role used
      // to be enough, which let any user enumerate anyone's invitations (role
      // matrix B2.4).
      if (
        playerId !== userId &&
        !(await isSystemAdmin(userId)) &&
        !(await isGuardianOf(userId, playerId))
      ) {
        if (teamId) {
          if (scopeToCaller) {
            throw new ForbiddenError('You can only view your own invitations');
          }
        } else {
          const { manageableTeamIds } = await getPlayerTeamAccess(userId, playerId);
          if (manageableTeamIds.length === 0) {
            throw new ForbiddenError('You can only view your own invitations');
          }
          where.teamId = { in: manageableTeamIds };
        }
      }

      where.playerId = playerId;
    } else if (scopeToCaller) {
      // If no playerId specified, default to the caller's own invitations plus
      // those addressed to the caller's children (guardian).
      const childIds = await GuardianService.getChildIds(userId);
      where.playerId = childIds.length > 0 ? { in: [userId, ...childIds] } : userId;
    }

    // Get total count and invitations in parallel
    const [total, invitations] = await Promise.all([
      prisma.teamInvitation.count({ where }),
      prisma.teamInvitation.findMany({
        where,
        select: INVITATION_SELECT,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return {
      invitations,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  /**
   * Get an invitation by ID
   * @param invitationId Invitation ID
   * @param userId User ID (for authorization)
   */
  static async getInvitationById(
    invitationId: string,
    userId: string
  ): Promise<InvitationWithRelations> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
      select: INVITATION_SELECT,
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user has access (team access or is the invited player)
    const hasAccess = await canAccessTeam(userId, invitation.teamId);
    const isPlayer = invitation.playerId === userId;

    if (!hasAccess && !isPlayer) {
      throw new ForbiddenError('You do not have access to this invitation');
    }

    return invitation;
  }

  /**
   * Accept an invitation
   * @param invitationId Invitation ID
   * @param userId User ID (must be the invited player)
   */
  static async acceptInvitation(
    invitationId: string,
    userId: string
  ): Promise<AcceptInvitationResult> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user is the invited player, or a guardian of the invited player
    if (invitation.playerId !== userId && !(await isGuardianOf(userId, invitation.playerId))) {
      throw new ForbiddenError('You can only accept your own invitations');
    }

    // Check invitation status
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot accept invitation with status: ${invitation.status}`
      );
    }

    // Check if invitation has expired
    if (new Date() > invitation.expiresAt) {
      await this.markExpired(invitationId);
      throw new BadRequestError('This invitation has expired');
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Flip PENDING -> ACCEPTED only if it is still PENDING. Two concurrent
      // accepts (double-tap, web + app) race here; the loser sees 0 rows and
      // gets a 400 instead of a P2002 500 from the TeamMember insert (audit #58).
      const updatedInvitation = await this.transitionPending(
        tx,
        invitationId,
        { status: 'ACCEPTED', acceptedAt: new Date() },
        'accept',
        INVITATION_SCALAR_SELECT
      );

      // Add player to team. Players added through the unified Add Player flow
      // (unification spec, case 2) are rostered at creation, so the membership
      // may already exist — accept then only flips the invitation; the
      // roster row (and any coach-set jersey/position) is left untouched.
      const teamMember = await tx.teamMember.upsert({
        where: {
          teamId_playerId: {
            teamId: invitation.teamId,
            playerId: invitation.playerId,
          },
        },
        create: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
        update: {},
        include: ACCEPTED_MEMBER_INCLUDE,
      });

      return { invitation: updatedInvitation, teamMember };
    });

    return result;
  }

  /**
   * Lazily mark a PENDING invitation EXPIRED. Status-guarded so a concurrent
   * accept/reject/cancel is never overwritten.
   */
  private static async markExpired(invitationId: string): Promise<void> {
    await prisma.teamInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  }

  /**
   * Move an invitation out of PENDING with a status predicate, returning the
   * updated row. Throws BadRequestError when the row is no longer PENDING —
   * i.e. another request won the race.
   */
  private static async transitionPending<S extends Prisma.TeamInvitationSelect>(
    tx: Prisma.TransactionClient,
    invitationId: string,
    data: Prisma.TeamInvitationUpdateManyMutationInput,
    action: 'accept' | 'reject' | 'cancel',
    // The caller's desired read-back shape — one SELECT, not two
    select: S
  ): Promise<Prisma.TeamInvitationGetPayload<{ select: S }>> {
    const { count } = await tx.teamInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data,
    });

    if (count === 0) {
      throw new BadRequestError(`Cannot ${action} invitation: it is no longer pending`);
    }

    return tx.teamInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select,
    });
  }

  /**
   * Consent guard (unification spec T1, narrowed by ship review): only the
   * invitee's explicit REJECTION revokes claimability. `syncUser` links ANY
   * unclaimed row by email on first WorkOS login (memberships kept), so an
   * email surviving a rejection would turn a later, unrelated sign-up into
   * silent team membership — auto-accept with extra steps. Strip the email
   * while the account is unclaimed, unless another live PENDING or ACCEPTED
   * invitation still references it. The roster entry survives (decision D1).
   *
   * Deliberately NOT stripped on CANCEL (a coach's own action must not
   * destroy coach/admin-entered emails, and re-inviting would create a
   * duplicate account) or on EXPIRY (the resend flow needs the address, and
   * the invite email already informed that mailbox).
   */
  private static async stripUnclaimedEmail(
    tx: Prisma.TransactionClient,
    playerId: string
  ): Promise<void> {
    // ACCEPTED counts too: an accepted-but-unclaimed player (web-link accept,
    // no WorkOS login yet) still needs the email to claim the account — another
    // team's cancel must not orphan a completed accept (red-team RT3).
    const otherLive = await tx.teamInvitation.count({
      where: { playerId, status: { in: ['PENDING', 'ACCEPTED'] } },
    });
    if (otherLive > 0) {
      return;
    }
    await tx.user.updateMany({
      where: { id: playerId, workosUserId: null },
      data: { email: null },
    });
  }

  /**
   * Reject an invitation
   * @param invitationId Invitation ID
   * @param userId User ID (must be the invited player)
   */
  static async rejectInvitation(invitationId: string, userId: string): Promise<InvitationWithTeam> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user is the invited player, or a guardian of the invited player
    if (invitation.playerId !== userId && !(await isGuardianOf(userId, invitation.playerId))) {
      throw new ForbiddenError('You can only reject your own invitations');
    }

    // Check invitation status (fast path; transitionPending re-checks under
    // the transaction so a racing accept can't be overwritten)
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot reject invitation with status: ${invitation.status}`
      );
    }

    return prisma.$transaction(async (tx) => {
      const updated = await this.transitionPending(
        tx,
        invitationId,
        { status: 'REJECTED', rejectedAt: new Date() },
        'reject',
        INVITATION_TEAM_SELECT
      );

      await this.stripUnclaimedEmail(tx, invitation.playerId);

      return updated;
    });
  }

  /**
   * Cancel an invitation (must have canManageRoster permission)
   * @param invitationId Invitation ID
   * @param userId User ID
   */
  static async cancelInvitation(invitationId: string, userId: string): Promise<InvitationSummary> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, invitation.teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to cancel invitations for this team');
    }

    // Check invitation status (fast path; transitionPending re-checks under
    // the transaction so a racing accept can't be overwritten)
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot cancel invitation with status: ${invitation.status}`
      );
    }

    return prisma.$transaction(async (tx) => {
      // No email strip on cancel — see stripUnclaimedEmail's docstring
      // (rejection-only rule, ship review decision).
      return this.transitionPending(
        tx,
        invitationId,
        { status: 'CANCELLED' },
        'cancel',
        INVITATION_SCALAR_SELECT
      );
    });
  }

  /**
   * Unified Add Player — `POST /teams/:teamId/players` (roster/invite
   * unification spec, docs/plans/roster-invite-unification-spec.md).
   *
   * Consent model:
   *
   * ```
   * playerEmail?                              rows created (one transaction)
   * ── none ────────────────► case 1: managed User + TeamMember
   * ── no claimed account ──► case 2: managed User (reused if unclaimed row
   *                                   exists) + TeamMember + TeamInvitation
   * ── claimed account ─────► case 3: TeamInvitation only (membership on
   *                                   accept; pre-consent membership would be
   *                                   auto-accept, deferred by D2)
   * ```
   *
   * `guardianEmail` additionally invites a parent/guardian, but only when the
   * player got a roster entry (cases 1-2) — the guardian system requires
   * membership. In case 3 the response carries `guardianInvited: false` and a
   * reason instead of failing the whole add.
   */
  static async addRosterPlayer(
    teamId: string,
    data: AddRosterPlayerInput,
    userId: string
  ): Promise<AddRosterPlayerResult> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError("You do not have permission to manage this team's roster");
    }

    const result: AddRosterPlayerResult = {
      rostered: false,
      invited: false,
      member: null,
      invitation: null,
      guardianInvited: false,
      emails: {},
    };
    let playerId: string;

    if (!data.playerEmail) {
      // Case 1 — roster-only managed player (today's addManagedPlayer).
      result.member = await prisma.$transaction(async (tx) => {
        const managedUser = await tx.user.create({
          data: {
            name: data.name,
            role: 'PLAYER',
            isManaged: true,
            managedById: userId,
            email: null,
            profilePictureUrl: data.profilePictureUrl,
          },
          select: { id: true },
        });

        return tx.teamMember.create({
          data: {
            teamId,
            playerId: managedUser.id,
            jerseyNumber: data.jerseyNumber,
            position: data.position,
          },
          include: ADDED_MEMBER_INCLUDE,
        });
      });
      result.rostered = true;
      playerId = result.member.playerId;
    } else {
      // Lowercase + insensitive match — see createInvitation (red-team RT1).
      const email = data.playerEmail.trim().toLowerCase();
      const existing = await prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });

      if (existing?.workosUserId) {
        // Case 3 — claimed account: invitation only.
        const created = await this.createCase3Invitation(teamId, existing.id, data, userId);
        result.invitation = created.invitation;
        result.invited = true;
        result.emails.player = created.emailSent ?? undefined;
        playerId = existing.id;
      } else {
        // Case 2 — new email, or an unclaimed pre-provisioned row (the
        // "middle case"): managed player rostered immediately + invitation.
        // Two coaches racing the same new email both pass the findUnique;
        // the loser's user.create aborts the transaction with P2002 and we
        // retry once against the row that now exists.
        let created: { member: AddedTeamMember; invitation: InvitationWithRelations; token: string };
        try {
          created = await this.createRosteredInvitedPlayer(teamId, data, userId, existing, email);
        } catch (err) {
          // The reuse target completed WorkOS signup mid-transaction — it is a
          // claimed account now, so fall back to case 3 (red-team RT4).
          if (err instanceof ClaimedMidCreateError) {
            const case3 = await this.createCase3Invitation(teamId, err.playerId, data, userId);
            result.invitation = case3.invitation;
            result.invited = true;
            result.emails.player = case3.emailSent ?? undefined;
            playerId = err.playerId;
            return this.attachGuardianInvite(teamId, playerId, data, userId, result);
          }
          const raced = await this.resolveEmailRaceWinner(email, err);
          if (raced.workosUserId) {
            const case3 = await this.createCase3Invitation(teamId, raced.id, data, userId);
            result.invitation = case3.invitation;
            result.invited = true;
            result.emails.player = case3.emailSent ?? undefined;
            playerId = raced.id;
            return this.attachGuardianInvite(teamId, playerId, data, userId, result);
          }
          created = await this.createRosteredInvitedPlayer(teamId, data, userId, raced, email);
        }

        result.member = created.member;
        result.invitation = this.toSummary(created.invitation);
        result.rostered = true;
        result.invited = true;
        playerId = created.member.playerId;
        result.emails.player =
          (await this.deliverInvitationEmail(created.invitation, created.token, 'added')) ??
          undefined;
      }
    }

    return this.attachGuardianInvite(teamId, playerId, data, userId, result);
  }

  /** Case 3 helper: invitation for a claimed account, "invited" email copy. */
  private static async createCase3Invitation(
    teamId: string,
    playerId: string,
    data: AddRosterPlayerInput,
    userId: string
  ): Promise<{ invitation: InvitationSummary; emailSent: boolean | null }> {
    await this.assertInvitable(teamId, playerId);

    const token = this.generateToken();
    const invitation = await this.createInvitationRow(
      buildInvitationData({
        teamId,
        playerId,
        invitedById: userId,
        token,
        expiresAt: invitationExpiry(),
        jerseyNumber: data.jerseyNumber,
        position: data.position,
      })
    );

    const emailSent = await this.deliverInvitationEmail(invitation, token, 'invited');
    return { invitation: this.toSummary(invitation), emailSent };
  }

  /**
   * Case 2 helper: managed user (created, or an unclaimed row reused — flags
   * set, `managedById` only when it was null, name/role never touched) +
   * membership + invitation, atomically. Any live PENDING invitation for the
   * pair is expired first (supersede semantics).
   */
  private static async createRosteredInvitedPlayer(
    teamId: string,
    data: AddRosterPlayerInput,
    userId: string,
    reuse: { id: string; managedById: string | null } | null,
    email: string
  ): Promise<{ member: AddedTeamMember; invitation: InvitationWithRelations; token: string }> {
    const token = this.generateToken();
    const expiresAt = invitationExpiry();

    return prisma.$transaction(async (tx) => {
      let playerId: string;
      if (reuse) {
        // Guarded on workosUserId so a signup completing in the window can
        // never flip a freshly claimed account back to coach-managed
        // (red-team RT4). Zero rows updated = claimed — re-branch to case 3.
        const { count } = await tx.user.updateMany({
          where: { id: reuse.id, workosUserId: null },
          data: {
            isManaged: true,
            ...(reuse.managedById ? {} : { managedById: userId }),
          },
        });
        if (count === 0) {
          throw new ClaimedMidCreateError(reuse.id);
        }
        playerId = reuse.id;
      } else {
        const created = await tx.user.create({
          data: {
            name: data.name,
            email,
            role: 'PLAYER',
            emailVerified: false,
            isManaged: true,
            managedById: userId,
            profilePictureUrl: data.profilePictureUrl,
          },
          select: { id: true },
        });
        playerId = created.id;
      }

      const existingMember = await tx.teamMember.findUnique({
        where: { teamId_playerId: { teamId, playerId } },
      });
      if (existingMember) {
        throw new BadRequestError('Player is already on this team');
      }

      await tx.teamInvitation.updateMany({
        where: { teamId, playerId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });

      const member = await tx.teamMember.create({
        data: {
          teamId,
          playerId,
          jerseyNumber: data.jerseyNumber,
          position: data.position,
        },
        include: ADDED_MEMBER_INCLUDE,
      });

      const invitation = await tx.teamInvitation.create({
        data: buildInvitationData({
          teamId,
          playerId,
          invitedById: userId,
          token,
          expiresAt,
          jerseyNumber: data.jerseyNumber,
          position: data.position,
        }),
        select: INVITATION_SELECT,
      });

      return { member, invitation, token };
    });
  }

  /** Strip relations down to the scalar summary, driven by the select
   * constant so the field list cannot drift (token was never selected). */
  private static toSummary(
    invitation: InvitationWithRelations | InvitationSummary
  ): InvitationSummary {
    const summary: Record<string, unknown> = {};
    for (const key of Object.keys(INVITATION_SCALAR_SELECT) as (keyof InvitationSummary)[]) {
      summary[key] = invitation[key];
    }
    return summary as InvitationSummary;
  }


  /** Guardian half of the unified Add Player (cases 1-2 only). */
  private static async attachGuardianInvite(
    teamId: string,
    playerId: string,
    data: AddRosterPlayerInput,
    userId: string,
    result: AddRosterPlayerResult
  ): Promise<AddRosterPlayerResult> {
    if (!data.guardianEmail || !data.guardianRelationship) {
      return result;
    }

    if (!result.rostered) {
      result.guardianReason =
        'Guardians can be added after the player accepts the invitation and joins the roster';
      return result;
    }

    try {
      const guardian = await GuardianService.inviteGuardian(
        teamId,
        playerId,
        { email: data.guardianEmail, relationship: data.guardianRelationship },
        userId
      );
      result.guardianInvited = true;
      result.emails.guardian = guardian.emailSent ?? undefined;
    } catch (err) {
      // The player was already created and rostered — report the guardian
      // failure instead of failing the whole add. Only operational AppError
      // messages are client-safe; anything else (e.g. a Prisma error) gets
      // the generic fallback (pre-landing review, security specialist).
      result.guardianReason =
        err instanceof AppError ? err.message : 'Failed to invite guardian';
      if (!(err instanceof AppError)) {
        logger.error('Guardian invite failed during unified Add Player', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  /**
   * Get an invitation by token (public, no user context required).
   * Returns a limited view safe to expose without authentication.
   */
  static async getInvitationByToken(token: string): Promise<PublicInvitation> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { token },
      select: {
        id: true,
        status: true,
        position: true,
        jerseyNumber: true,
        message: true,
        expiresAt: true,
        team: {
          select: { name: true },
        },
        invitedBy: {
          select: { name: true },
        },
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    return {
      id: invitation.id,
      status: invitation.status,
      teamName: invitation.team.name,
      inviterName: invitation.invitedBy.name,
      position: invitation.position,
      jerseyNumber: invitation.jerseyNumber,
      message: invitation.message,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Accept an invitation using its token as authentication.
   * The token functions as a one-time secret (analogous to a password-reset link).
   */
  static async acceptInvitationByToken(token: string): Promise<AcceptInvitationByTokenResult> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestError('This invitation has already been accepted');
    }

    if (invitation.status === 'REJECTED') {
      throw new BadRequestError('This invitation has been rejected');
    }

    if (invitation.status === 'CANCELLED') {
      throw new BadRequestError('This invitation has been cancelled');
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot accept invitation with status: ${invitation.status}`);
    }

    if (new Date() > invitation.expiresAt) {
      await this.markExpired(invitation.id);
      throw new BadRequestError('This invitation has expired');
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedInvitation = await this.transitionPending(
        tx,
        invitation.id,
        { status: 'ACCEPTED', acceptedAt: new Date() },
        'accept',
        INVITATION_SCALAR_SELECT
      );

      // Membership may already exist for players rostered at creation
      // (unification spec, case 2) — see acceptInvitation.
      const teamMember = await tx.teamMember.upsert({
        where: {
          teamId_playerId: {
            teamId: invitation.teamId,
            playerId: invitation.playerId,
          },
        },
        create: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
        update: {},
      });

      return { invitation: updatedInvitation, teamMember };
    });

    return result;
  }

  /**
   * Bulk-expire PENDING invitations past their expiresAt.
   *
   * Not scheduled anywhere today — expiry is applied lazily by
   * createInvitation (dedupe) and accept/acceptByToken (audit #23). Kept for a
   * future cron/maintenance job.
   */
  static async expireOldInvitations(): Promise<Prisma.BatchPayload> {
    const now = new Date();

    const result = await prisma.teamInvitation.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: {
          lt: now,
        },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    return result;
  }
}
