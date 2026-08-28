/**
 * Guardian (PARENT role) service — docs/plans/parent-role-spec.md.
 *
 * A guardian is an adult `User` linked to one or more child players through
 * `Guardian { parentId, childId, relationship, isPrimary }`. Links are created
 * by accepting a `GuardianInvitation` that a roster manager sends from a
 * player's roster card. The invitation token is a bearer secret exactly like a
 * `TeamInvitation` token: it only ever travels inside the email and is never
 * returned on an authenticated response.
 */

import { GuardianRelationship, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import prisma from '../models';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { hasTeamPermission, isGuardianOf } from '../utils/permissions';
import { mailer } from './mailer';
import { guardianInvitationTemplate } from './mailer/templates';
import { logger } from '../utils/logger';
import { formatEmailDate } from '../utils/format-date';

const GUARDIAN_INVITE_EXPIRES_DAYS = 7;

/** Scalar fields safe to return on authenticated responses (no `token`). */
const GUARDIAN_INVITATION_SELECT = {
  id: true,
  childId: true,
  teamId: true,
  invitedEmail: true,
  relationship: true,
  invitedById: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  acceptedAt: true,
} satisfies Prisma.GuardianInvitationSelect;

const GUARDIAN_INCLUDE = {
  parent: { select: { id: true, name: true, email: true } },
} satisfies Prisma.GuardianInclude;

export type GuardianInvitationSummary = Prisma.GuardianInvitationGetPayload<{
  select: typeof GUARDIAN_INVITATION_SELECT;
}>;

type GuardianWithParent = Prisma.GuardianGetPayload<{ include: typeof GUARDIAN_INCLUDE }>;

export interface GuardianSummary {
  id: string;
  userId: string;
  name: string;
  /** Present only when the caller has `canManageRoster` on the team. */
  email?: string | null;
  relationship: GuardianRelationship;
  isPrimary: boolean;
  createdAt: Date;
}

export interface GuardianList {
  guardians: GuardianSummary[];
  pendingInvitations: GuardianInvitationSummary[];
}

export interface GuardianOfEntry {
  childId: string;
  childName: string;
  relationship: GuardianRelationship;
  isPrimary: boolean;
}

export interface InviteGuardianInput {
  email: string;
  relationship: GuardianRelationship;
}

/** Limited, unauthenticated view of a guardian invitation (public token lookup). */
export interface PublicGuardianInvitation {
  kind: 'guardian';
  id: string;
  status: GuardianInvitationSummary['status'];
  childName: string;
  teamName: string | null;
  inviterName: string;
  relationship: GuardianRelationship;
  expiresAt: string;
}

export interface AcceptGuardianInvitationResult {
  kind: 'guardian';
  invitation: GuardianInvitationSummary;
  guardian: {
    id: string;
    parentId: string;
    childId: string;
    relationship: GuardianRelationship;
    isPrimary: boolean;
  };
}

function toSummary(g: GuardianWithParent, includeEmail: boolean): GuardianSummary {
  return {
    id: g.id,
    userId: g.parentId,
    name: g.parent.name,
    ...(includeEmail && { email: g.parent.email }),
    relationship: g.relationship,
    isPrimary: g.isPrimary,
    createdAt: g.createdAt,
  };
}

export class GuardianService {
  private static generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Children the user is a guardian of — the `guardianOf` block on
   * `GET /auth/me` and `/auth/callback`.
   */
  static async getGuardianOf(userId: string): Promise<GuardianOfEntry[]> {
    const links = await prisma.guardian.findMany({
      where: { parentId: userId },
      select: {
        childId: true,
        relationship: true,
        isPrimary: true,
        child: {
          select: {
            name: true,
            teamMembers: { select: { team: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return links.map((link) => ({
      childId: link.childId,
      childName: link.child.name,
      relationship: link.relationship,
      isPrimary: link.isPrimary,
      // Lets the app deep-link to the child's guardians screen, which is
      // addressed per team (/teams/:teamId/members/:playerId/guardians).
      teams: (link.child.teamMembers ?? []).map((m) => ({ id: m.team.id, name: m.team.name })),
    }));
  }

  /** Ids of the user's children (for scoping list queries). */
  static async getChildIds(userId: string): Promise<string[]> {
    const links = await prisma.guardian.findMany({
      where: { parentId: userId },
      select: { childId: true },
    });
    return (links ?? []).map((l) => l.childId);
  }

  /**
   * Pending, unexpired guardian invitations addressed to the signed-in adult
   * (matched on the account email, case-insensitively). Surfaced on
   * `GET /invitations` as `guardianInvitations` so the mobile Invitations tab
   * can offer "Accept for <child>"; accepting goes through
   * `POST /invitations/:id/accept`. Never includes the token.
   */
  static async listPendingForUser(userId: string): Promise<PublicGuardianInvitation[]> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return [];

    const rows = await prisma.guardianInvitation.findMany({
      where: {
        invitedEmail: { equals: user.email, mode: 'insensitive' },
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        status: true,
        relationship: true,
        expiresAt: true,
        child: { select: { name: true } },
        team: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return (rows ?? []).map((invitation) => ({
      kind: 'guardian' as const,
      id: invitation.id,
      status: invitation.status,
      childName: invitation.child.name,
      teamName: invitation.team?.name ?? null,
      inviterName: invitation.invitedBy.name,
      relationship: invitation.relationship,
      expiresAt: invitation.expiresAt.toISOString(),
    }));
  }

  /**
   * Ensure the player is rostered on the team; returns the member's user row.
   */
  private static async requireMember(
    teamId: string,
    playerId: string
  ): Promise<{ id: string; name: string; email: string | null }> {
    const member = await prisma.teamMember.findUnique({
      where: { teamId_playerId: { teamId, playerId } },
      select: { player: { select: { id: true, name: true, email: true } } },
    });

    if (!member) {
      throw new NotFoundError('Player is not on this team');
    }

    return member.player;
  }

  /**
   * Invite an adult (by email) to become a guardian of a rostered player.
   * Requires `canManageRoster` on the team. Creates (or reuses) the adult's
   * `User` row with role PARENT and a PENDING `GuardianInvitation`, then emails
   * a `${PUBLIC_APP_URL}/invite/<token>` link.
   */
  static async inviteGuardian(
    teamId: string,
    playerId: string,
    data: InviteGuardianInput,
    userId: string
  ): Promise<GuardianInvitationSummary & { emailSent: boolean }> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError("You do not have permission to manage this team's roster");
    }

    const child = await this.requireMember(teamId, playerId);
    const email = data.email.trim().toLowerCase();

    if (child.email && child.email.toLowerCase() === email) {
      throw new BadRequestError('A player cannot be their own guardian');
    }

    // Find or create the adult's account. A brand-new account created through
    // a guardian invite is PARENT; an existing account keeps its role (a coach
    // who is also a parent stays COACH).
    let parent = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true },
    });

    if (!parent) {
      parent = await prisma.user.create({
        data: {
          name: email.split('@')[0],
          email,
          role: 'PARENT',
          emailVerified: false,
        },
        select: { id: true, name: true, email: true },
      });
    }

    const alreadyLinked = await prisma.guardian.findUnique({
      where: { parentId_childId: { parentId: parent.id, childId: playerId } },
    });
    if (alreadyLinked) {
      throw new BadRequestError('This person is already a guardian of this player');
    }

    // Dedupe: one live PENDING invitation per child/email. An expired PENDING
    // row is flipped to EXPIRED and does not block (same lazy expiry as
    // TeamInvitation).
    const existing = await prisma.guardianInvitation.findFirst({
      where: { childId: playerId, invitedEmail: email, status: 'PENDING' },
    });
    if (existing) {
      if (existing.expiresAt.getTime() > Date.now()) {
        throw new BadRequestError('A pending guardian invitation already exists for this email');
      }
      await prisma.guardianInvitation.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    }

    const inviter = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + GUARDIAN_INVITE_EXPIRES_DAYS);

    const invitation = await prisma.guardianInvitation.create({
      data: {
        token,
        childId: playerId,
        teamId,
        invitedEmail: email,
        relationship: data.relationship,
        invitedById: userId,
        expiresAt,
        status: 'PENDING',
      },
      select: GUARDIAN_INVITATION_SELECT,
    });

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://capyhoops.com';
    const acceptUrl = `${baseUrl}/invite/${token}`;
    // Awaited so callers can surface a failed send to the coach (unification
    // spec: silent email failures were invisible, SES-sandbox incident
    // 2026-08-28). Failures are logged and reported, never thrown — the
    // invitation row is committed and usable in-app.
    let emailSent: boolean;
    try {
      await mailer.send({
        template: guardianInvitationTemplate,
        to: email,
        variables: {
          guardianName: parent.name,
          childName: child.name,
          teamName: team.name,
          inviterName: inviter?.name ?? inviter?.email ?? '',
          expiresAt: formatEmailDate(invitation.expiresAt),
          acceptUrl,
        },
        metadata: {
          userId: parent.id,
          event_type: 'guardian_invitation.created',
          teamId,
          childId: playerId,
          invitationId: invitation.id,
        },
      });
      emailSent = true;
    } catch (err: unknown) {
      logger.error('Failed to send guardian invitation email', {
        error: err instanceof Error ? err.message : String(err),
        invitationId: invitation.id,
      });
      emailSent = false;
    }

    return { ...invitation, emailSent };
  }

  /**
   * Guardians (and pending guardian invitations) of a rostered player.
   * Visible to roster managers and to the player's own guardians. Guardian
   * emails are returned only to roster managers.
   */
  static async listGuardians(teamId: string, playerId: string, userId: string): Promise<GuardianList> {
    await this.requireMember(teamId, playerId);

    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster && !(await isGuardianOf(userId, playerId))) {
      throw new ForbiddenError("You do not have access to this player's guardians");
    }

    const [guardians, pendingInvitations] = await Promise.all([
      prisma.guardian.findMany({
        where: { childId: playerId },
        include: GUARDIAN_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.guardianInvitation.findMany({
        where: { childId: playerId, status: 'PENDING', expiresAt: { gt: new Date() } },
        select: GUARDIAN_INVITATION_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      guardians: guardians.map((g) => toSummary(g, canManageRoster)),
      pendingInvitations,
    };
  }

  /**
   * Unlink a guardian from a player. Allowed for roster managers or for the
   * guardian removing themself. Removing the last guardian never deletes the
   * child. If the primary guardian leaves, the oldest remaining link becomes
   * primary.
   */
  static async removeGuardian(
    teamId: string,
    playerId: string,
    guardianUserId: string,
    userId: string
  ): Promise<void> {
    await this.requireMember(teamId, playerId);

    if (guardianUserId !== userId) {
      const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
      if (!canManageRoster) {
        throw new ForbiddenError("You do not have permission to manage this player's guardians");
      }
    }

    const link = await prisma.guardian.findUnique({
      where: { parentId_childId: { parentId: guardianUserId, childId: playerId } },
    });

    if (!link) {
      throw new NotFoundError('Guardian link not found');
    }

    await prisma.$transaction(async (tx) => {
      await tx.guardian.delete({ where: { id: link.id } });

      if (link.isPrimary) {
        const next = await tx.guardian.findFirst({
          where: { childId: playerId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next) {
          await tx.guardian.update({ where: { id: next.id }, data: { isPrimary: true } });
        }
      }
    });
  }

  /**
   * Public, unauthenticated view of a guardian invitation (web invite page).
   */
  static async getInvitationByToken(token: string): Promise<PublicGuardianInvitation> {
    const invitation = await prisma.guardianInvitation.findUnique({
      where: { token },
      select: {
        id: true,
        status: true,
        relationship: true,
        expiresAt: true,
        child: { select: { name: true } },
        team: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    return {
      kind: 'guardian',
      id: invitation.id,
      status: invitation.status,
      childName: invitation.child.name,
      teamName: invitation.team?.name ?? null,
      inviterName: invitation.invitedBy.name,
      relationship: invitation.relationship,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Accept by token (unauthenticated; the token is the secret). The guardian
   * is the account whose email the invitation was addressed to.
   */
  static async acceptInvitationByToken(token: string): Promise<AcceptGuardianInvitationResult> {
    const invitation = await prisma.guardianInvitation.findUnique({ where: { token } });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    return this.accept(invitation);
  }

  /**
   * Authenticated accept by id: the caller must be the invited adult (their
   * account email matches `invitedEmail`).
   */
  static async acceptInvitation(
    invitationId: string,
    userId: string
  ): Promise<AcceptGuardianInvitationResult> {
    const invitation = await this.requireInvitedUser(invitationId, userId);
    return this.accept(invitation);
  }

  /**
   * Authenticated reject by id (the invited adult declines).
   */
  static async rejectInvitation(
    invitationId: string,
    userId: string
  ): Promise<GuardianInvitationSummary> {
    const invitation = await this.requireInvitedUser(invitationId, userId);

    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot reject invitation with status: ${invitation.status}`);
    }

    return prisma.guardianInvitation.update({
      where: { id: invitation.id },
      data: { status: 'REJECTED' },
      select: GUARDIAN_INVITATION_SELECT,
    });
  }

  /** Look up a guardian invitation by id and assert the caller is its addressee. */
  static async findInvitationForUser(
    invitationId: string,
    userId: string
  ): Promise<Prisma.GuardianInvitationGetPayload<object> | null> {
    const invitation = await prisma.guardianInvitation.findUnique({ where: { id: invitationId } });
    if (!invitation) {
      return null;
    }
    await this.assertAddressee(invitation, userId);
    return invitation;
  }

  private static async requireInvitedUser(
    invitationId: string,
    userId: string
  ): Promise<Prisma.GuardianInvitationGetPayload<object>> {
    const invitation = await this.findInvitationForUser(invitationId, userId);
    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }
    return invitation;
  }

  private static async assertAddressee(
    invitation: { invitedEmail: string },
    userId: string
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email || user.email.toLowerCase() !== invitation.invitedEmail.toLowerCase()) {
      throw new ForbiddenError('This invitation was not sent to you');
    }
  }

  private static async accept(
    invitation: Prisma.GuardianInvitationGetPayload<object>
  ): Promise<AcceptGuardianInvitationResult> {
    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestError('This invitation has already been accepted');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot accept invitation with status: ${invitation.status}`);
    }
    if (new Date() > invitation.expiresAt) {
      await prisma.guardianInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestError('This invitation has expired');
    }

    // The adult's account was created (or matched) at invite time; a retry
    // after a partial failure, or a later sign-up, may still need it created.
    let parent = await prisma.user.findUnique({
      where: { email: invitation.invitedEmail },
      select: { id: true, role: true },
    });
    if (!parent) {
      parent = await prisma.user.create({
        data: {
          name: invitation.invitedEmail.split('@')[0],
          email: invitation.invitedEmail,
          role: 'PARENT',
          emailVerified: false,
        },
        select: { id: true, role: true },
      });
    }
    const parentId = parent.id;

    return prisma.$transaction(async (tx) => {
      const { count } = await tx.guardianInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      if (count === 0) {
        throw new BadRequestError('Cannot accept invitation: it is no longer pending');
      }

      const updatedInvitation = await tx.guardianInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: GUARDIAN_INVITATION_SELECT,
      });

      const existingLink = await tx.guardian.findUnique({
        where: { parentId_childId: { parentId, childId: invitation.childId } },
      });

      const guardian =
        existingLink ??
        (await tx.guardian.create({
          data: {
            parentId,
            childId: invitation.childId,
            relationship: invitation.relationship,
            // Exactly one primary per child: the first link.
            isPrimary: (await tx.guardian.count({ where: { childId: invitation.childId } })) === 0,
          },
        }));

      // Role is derived: only a bare PLAYER account (no team memberships, no
      // staff rows) becomes PARENT. A coach who is also a parent stays COACH.
      if (parent.role === 'PLAYER') {
        const [memberships, staffRows] = await Promise.all([
          tx.teamMember.count({ where: { playerId: parentId } }),
          tx.teamStaff.count({ where: { userId: parentId } }),
        ]);
        if (memberships === 0 && staffRows === 0) {
          await tx.user.update({ where: { id: parentId }, data: { role: 'PARENT' } });
        }
      }

      return {
        kind: 'guardian' as const,
        invitation: updatedInvitation,
        guardian: {
          id: guardian.id,
          parentId: guardian.parentId,
          childId: guardian.childId,
          relationship: guardian.relationship,
          isPrimary: guardian.isPrimary,
        },
      };
    });
  }
}
