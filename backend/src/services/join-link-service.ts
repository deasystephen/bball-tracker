/**
 * Team join links (#210): self-serve roster onboarding.
 *
 * A roster manager creates ONE reusable link per team and drops it in the
 * team's group chat (or shows it as a QR code). Unlike the three invitation
 * kinds, the link names nobody, so holding it grants nothing by itself: a
 * signed-in account ASKS to join through it (`TeamJoinRequest`) and a roster
 * manager approves or declines each request. Nobody who merely holds a leaked
 * link ever reads the roster.
 *
 * Who can ask (accounts are adults, `docs/architecture/children-and-age.md`):
 *  - SELF: the account holder joins as a player. Approval adds the
 *    `TeamMember` row for the account (existing membership is left as it is).
 *  - CHILD: a parent adds their child. Approval creates what Add Player's
 *    case 1 plus an accepted guardian invitation would have: a managed roster
 *    record (`isManaged`, no login, `managedById` = the approving coach), its
 *    `TeamMember` row and the `Guardian` link to the requester, who becomes
 *    PARENT by the guardian accept's rule. The child never gets a login.
 *
 * The token is a bearer secret. It is read only through
 * `JOIN_LINK_MANAGER_SELECT`, returned only to roster managers (as the URL
 * they share), and never logged. A revoked link answers 404 like an unknown
 * one, so a rotated link tells its holder nothing.
 *
 * Detail: docs/architecture/roster-and-invitations.md, Team join links.
 */

import { GuardianRelationship, JoinRequestKind, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import prisma from '../models';
import { BadRequestError, ForbiddenError, JoinLinkInactiveError, NotFoundError } from '../utils/errors';
import { hasTeamPermission } from '../utils/permissions';
import { lockTeamRow } from '../utils/team-row-lock';
import { lockUsers } from '../utils/user-row-lock';
import { logger } from '../utils/logger';
import { publicAppUrl } from '../utils/urls';
import { USER_SUMMARY_WITH_EMAIL_SELECT } from '../utils/user-select';
import { GuardianService } from './guardian-service';
import { NotificationService } from './notification-service';
import type { CreateJoinLinkInput, JoinRequestInput } from '../api/join/schemas';

/** A link nobody rotates dies by itself: the default lifetime when the coach picks none. */
export const JOIN_LINK_DEFAULT_EXPIRES_DAYS = 14;

/**
 * Pending requests one account may hold on one team (itself plus children).
 * A family with more children waits for the coach to decide some; a looping
 * account cannot fill the coach's list.
 */
export const MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT = 6;

const JOIN_LINK_NOT_FOUND = 'Join link not found';
const JOIN_REQUEST_NOT_FOUND = 'Join request not found';
const NO_ROSTER_PERMISSION = "You do not have permission to manage this team's roster";

/** Scalar fields of a link that carry no secret. */
const JOIN_LINK_SELECT = {
  id: true,
  teamId: true,
  expiresAt: true,
  maxUses: true,
  useCount: true,
  createdAt: true,
} satisfies Prisma.TeamJoinLinkSelect;

/**
 * The link as a roster manager gets it, WITH the token: they are the people
 * who share it. The only select that reads `token` besides the public lookup's
 * `where`. Never use it for any other caller.
 */
const JOIN_LINK_MANAGER_SELECT = {
  ...JOIN_LINK_SELECT,
  token: true,
} satisfies Prisma.TeamJoinLinkSelect;

/** What the public lookup reads: enough to decide the state and name the team. */
const JOIN_LINK_PUBLIC_SELECT = {
  id: true,
  teamId: true,
  expiresAt: true,
  maxUses: true,
  useCount: true,
  revokedAt: true,
  team: { select: { name: true } },
} satisfies Prisma.TeamJoinLinkSelect;

/** A request as its requester sees it. */
const JOIN_REQUEST_SELECT = {
  id: true,
  kind: true,
  status: true,
  createdAt: true,
} satisfies Prisma.TeamJoinRequestSelect;

/** A pending request as the team's roster managers list it. */
export const JOIN_REQUEST_LIST_SELECT = {
  ...JOIN_REQUEST_SELECT,
  childName: true,
  relationship: true,
  // Roster managers already see roster emails; the address is how a coach
  // recognises who is asking.
  requester: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
} satisfies Prisma.TeamJoinRequestSelect;

type JoinLinkManagerRow = Prisma.TeamJoinLinkGetPayload<{ select: typeof JOIN_LINK_MANAGER_SELECT }>;
type JoinLinkPublicRow = Prisma.TeamJoinLinkGetPayload<{ select: typeof JOIN_LINK_PUBLIC_SELECT }>;
export type JoinRequestSummary = Prisma.TeamJoinRequestGetPayload<{ select: typeof JOIN_REQUEST_SELECT }>;
export type JoinRequestListItem = Prisma.TeamJoinRequestGetPayload<{ select: typeof JOIN_REQUEST_LIST_SELECT }>;

/** The team's live link for a roster manager. `url` carries the token; there is no separate token field. */
export interface JoinLinkView {
  id: string;
  teamId: string;
  url: string;
  expiresAt: Date;
  maxUses: number | null;
  useCount: number;
  createdAt: Date;
}

/** What a link holder may know about a link that is not revoked. */
export type JoinLinkState = 'active' | 'expired' | 'full';

/** The public preview: the team's name and whether the link still takes requests. Nothing else. */
export interface JoinLinkPreview {
  teamName: string;
  state: JoinLinkState;
}

export type JoinRequestResult =
  /** The caller (or the named child they guard) is already on the roster: nothing was written. */
  | { status: 'already_member'; teamId: string; teamName: string }
  /** A request is waiting for a coach; `created` is false when it already existed. */
  | { status: 'pending'; created: boolean; teamName: string; request: JoinRequestSummary };

export interface ApproveJoinRequestResult {
  request: JoinRequestSummary;
  /** The roster record the approval wrote: the requester (SELF) or the new managed child (CHILD). */
  playerId: string;
}

function toView(row: JoinLinkManagerRow): JoinLinkView {
  const { token, ...rest } = row;
  return { ...rest, url: `${publicAppUrl()}/join/${token}` };
}

function linkState(row: Pick<JoinLinkPublicRow, 'expiresAt' | 'maxUses' | 'useCount'>, now: Date): JoinLinkState {
  if (row.expiresAt <= now) {
    return 'expired';
  }
  if (row.maxUses !== null && row.useCount >= row.maxUses) {
    return 'full';
  }
  return 'active';
}

/** Names compared the way a coach reads them: trimmed, inner whitespace collapsed, case ignored. */
function sameName(a: string, b: string): boolean {
  const fold = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return fold(a) === fold(b);
}

export class JoinLinkService {
  private static generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Team 404, then the roster-manager gate (403). Returns the team's name. */
  private static async requireRosterManager(teamId: string, userId: string): Promise<{ id: string; name: string }> {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, name: true } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    if (!(await hasTeamPermission(userId, teamId, 'canManageRoster'))) {
      throw new ForbiddenError(NO_ROSTER_PERMISSION);
    }
    return team;
  }

  /**
   * Create the team's join link, revoking any live one in the same
   * transaction (create = rotate: the old link dies the moment the new one
   * exists). Gate: `canManageRoster`. Behind the creator's `User` row lock,
   * then the team row lock (account deletion's order), so two creates end
   * with exactly one live link and a deleted account never owns one.
   */
  static async createLink(teamId: string, data: CreateJoinLinkInput, userId: string): Promise<JoinLinkView> {
    await this.requireRosterManager(teamId, userId);

    const expiresInDays = data.expiresInDays ?? JOIN_LINK_DEFAULT_EXPIRES_DAYS;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const token = this.generateToken();

    const { link, revokedCount } = await prisma.$transaction(async (tx) => {
      const [creator] = await lockUsers(tx, [userId]);
      if (!creator || creator.deletedAt !== null) {
        throw new NotFoundError('Account not found');
      }
      if (!(await lockTeamRow(tx, teamId))) {
        throw new NotFoundError('Team not found');
      }
      const revoked = await tx.teamJoinLink.updateMany({
        where: { teamId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const created = await tx.teamJoinLink.create({
        data: { teamId, token, createdById: userId, expiresAt, maxUses: data.maxUses ?? null },
        select: JOIN_LINK_MANAGER_SELECT,
      });
      return { link: created, revokedCount: revoked.count };
    });

    logger.info('Join link created', {
      linkId: link.id,
      teamId,
      userId,
      expiresInDays,
      maxUses: link.maxUses,
      revokedCount,
    });

    return toView(link);
  }

  /**
   * The team's live link (not revoked, not expired), for roster managers; a
   * link that reached its cap is still returned so the coach sees why nobody
   * can use it. `null` when there is none.
   */
  static async getLink(teamId: string, userId: string): Promise<JoinLinkView | null> {
    await this.requireRosterManager(teamId, userId);
    const link = await prisma.teamJoinLink.findFirst({
      where: { teamId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: JOIN_LINK_MANAGER_SELECT,
    });
    return link ? toView(link) : null;
  }

  /**
   * Revoke every live link of the team (gate `canManageRoster`). Requests
   * already waiting stay for the coach to decide: families who asked through
   * the link before it leaked are not thrown away with it.
   */
  static async revokeLinks(teamId: string, userId: string): Promise<{ revoked: number }> {
    await this.requireRosterManager(teamId, userId);
    const { count } = await prisma.teamJoinLink.updateMany({
      where: { teamId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.info('Join link revoked', { teamId, userId, revokedCount: count });
    return { revoked: count };
  }

  /** The link behind a token, or 404; a revoked link reads as unknown. */
  private static async findLiveLink(token: string): Promise<JoinLinkPublicRow> {
    const link = await prisma.teamJoinLink.findUnique({ where: { token }, select: JOIN_LINK_PUBLIC_SELECT });
    if (!link || link.revokedAt !== null) {
      throw new NotFoundError(JOIN_LINK_NOT_FOUND);
    }
    return link;
  }

  /**
   * Public, unauthenticated preview (web `/join/<token>` page, app deep
   * link): the team's name and the link's state only. No roster, no coach, no
   * counts. `linkId` is for the caller's log line, never for the response.
   */
  static async previewByToken(token: string): Promise<JoinLinkPreview & { linkId: string }> {
    const link = await this.findLiveLink(token);
    return { linkId: link.id, teamName: link.team.name, state: linkState(link, new Date()) };
  }

  /**
   * A signed-in account asks to join through the link. Idempotent: an
   * account (or a child it guards, matched by name) already on the roster
   * answers `already_member` and writes nothing; a request already waiting is
   * returned as it is. Otherwise one transaction, behind the requester's
   * `User` row lock (so a double tap creates one request and account deletion
   * never leaves a request behind):
   *  - the per-account pending cap;
   *  - one use of the link, taken by a single conditional UPDATE (not
   *    revoked, not expired, under `maxUses`), so the cap holds under
   *    concurrency;
   *  - the PENDING request.
   * Nothing is added to the roster here; a roster manager decides.
   */
  static async requestToJoin(token: string, data: JoinRequestInput, userId: string): Promise<JoinRequestResult> {
    const link = await this.findLiveLink(token);
    const state = linkState(link, new Date());
    if (state !== 'active') {
      throw new JoinLinkInactiveError(state);
    }
    const teamId = link.teamId;
    const teamName = link.team.name;
    const kind: JoinRequestKind = data.kind === 'child' ? 'CHILD' : 'SELF';
    const childName = data.kind === 'child' ? data.childName : null;

    const result = await prisma.$transaction(async (tx): Promise<JoinRequestResult> => {
      const [requester] = await lockUsers(tx, [userId]);
      if (!requester || requester.deletedAt !== null) {
        throw new NotFoundError('Account not found');
      }

      const pending = await tx.teamJoinRequest.findMany({
        where: { teamId, requesterId: userId, status: 'PENDING' },
        select: { ...JOIN_REQUEST_SELECT, childName: true },
        orderBy: { createdAt: 'asc' },
      });

      if (childName === null) {
        const member = await tx.teamMember.findUnique({
          where: { teamId_playerId: { teamId, playerId: userId } },
          select: { id: true },
        });
        if (member) {
          return { status: 'already_member', teamId, teamName };
        }
      } else {
        // The children this account already guards on the team, compared by
        // name in code (a handful of rows; no pattern match in SQL).
        const guarded = await tx.guardian.findMany({
          where: { parentId: userId, child: { deletedAt: null, teamMembers: { some: { teamId } } } },
          select: { child: { select: { name: true, deletedAt: true } } },
        });
        if (guarded.some((row) => sameName(row.child.name, childName))) {
          return { status: 'already_member', teamId, teamName };
        }
      }

      const existing = pending.find((row) =>
        childName === null ? row.kind === 'SELF' : row.kind === 'CHILD' && sameName(row.childName ?? '', childName)
      );
      if (existing) {
        return {
          status: 'pending',
          created: false,
          teamName,
          request: { id: existing.id, kind: existing.kind, status: existing.status, createdAt: existing.createdAt },
        };
      }
      if (pending.length >= MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT) {
        throw new BadRequestError(
          'You already have several requests waiting for this team. Ask the coach to review them first.'
        );
      }

      // One use, taken atomically: a link revoked, expired or filled since
      // the unlocked read above matches no row.
      const taken = await tx.$executeRaw`
        UPDATE "TeamJoinLink"
        SET "useCount" = "useCount" + 1, "updatedAt" = NOW()
        WHERE "id" = ${link.id}
          AND "revokedAt" IS NULL
          AND "expiresAt" > NOW()
          AND ("maxUses" IS NULL OR "useCount" < "maxUses")`;
      if (taken === 0) {
        const fresh = await tx.teamJoinLink.findUnique({ where: { id: link.id }, select: JOIN_LINK_PUBLIC_SELECT });
        if (!fresh || fresh.revokedAt !== null) {
          throw new NotFoundError(JOIN_LINK_NOT_FOUND);
        }
        const freshState = linkState(fresh, new Date());
        throw new JoinLinkInactiveError(freshState === 'active' ? 'full' : freshState);
      }

      const request = await tx.teamJoinRequest.create({
        data: {
          teamId,
          linkId: link.id,
          requesterId: userId,
          kind,
          childName,
          relationship: data.kind === 'child' ? data.relationship : null,
        },
        select: JOIN_REQUEST_SELECT,
      });
      return { status: 'pending', created: true, teamName, request };
    });

    if (result.status === 'pending' && result.created) {
      logger.info('Join request created', {
        requestId: result.request.id,
        teamId,
        linkId: link.id,
        requesterId: userId,
        kind,
      });
      await this.notifyRosterManagers(teamId, teamName);
    }

    return result;
  }

  /**
   * Best-effort push to the team's roster managers: a request is waiting. No
   * name in the push (lock screens); the app lists the requests. A failed
   * push never fails the request.
   */
  private static async notifyRosterManagers(teamId: string, teamName: string): Promise<void> {
    try {
      const managers = await prisma.teamStaff.findMany({
        where: { teamId, role: { canManageRoster: true } },
        select: { userId: true },
      });
      if (managers.length === 0) {
        return;
      }
      await NotificationService.sendToUsers(
        managers.map((row) => row.userId),
        {
          title: 'New join request',
          body: `Someone asked to join ${teamName}. Review the request in the app.`,
          data: { type: 'join_request', teamId },
        }
      );
    } catch (err: unknown) {
      logger.warn('Join request push failed', {
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Best-effort push to the requester once a coach approved. */
  private static async notifyRequester(requesterId: string, teamId: string, teamName: string): Promise<void> {
    try {
      await NotificationService.sendToUsers([requesterId], {
        title: 'Request approved',
        body: `You have been added to ${teamName}.`,
        data: { type: 'join_request_approved', teamId },
      });
    } catch (err: unknown) {
      logger.warn('Join approval push failed', {
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The team's pending join requests, oldest first, for roster managers only. */
  static async listRequests(teamId: string, userId: string): Promise<JoinRequestListItem[]> {
    await this.requireRosterManager(teamId, userId);
    return prisma.teamJoinRequest.findMany({
      where: { teamId, status: 'PENDING' },
      select: JOIN_REQUEST_LIST_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Team 404, the 403 gate, then the request (404 for another team's id, so a
   * caller who may not manage the roster learns nothing about ids), then the
   * status (400 once it has been decided).
   */
  private static async requirePendingRequest(
    teamId: string,
    requestId: string,
    userId: string,
    verb: 'approve' | 'decline'
  ): Promise<{
    team: { id: string; name: string };
    request: { id: string; requesterId: string; kind: JoinRequestKind; childName: string | null; relationship: GuardianRelationship | null };
  }> {
    const team = await this.requireRosterManager(teamId, userId);
    const request = await prisma.teamJoinRequest.findFirst({
      where: { id: requestId, teamId },
      select: { id: true, requesterId: true, kind: true, childName: true, relationship: true, status: true },
    });
    if (!request) {
      throw new NotFoundError(JOIN_REQUEST_NOT_FOUND);
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestError(`Cannot ${verb} a join request with status: ${request.status}`);
    }
    return { team, request };
  }

  /**
   * A roster manager approves a request: the roster is written here, in one
   * transaction.
   *  - Locks the requester and the approver (`lockUsers`, one id-ordered
   *    statement): a deleted account never gets a membership or a guardian
   *    link (its requests were removed with it), and a deleted approver never
   *    becomes a child's `managedById`.
   *  - Flips PENDING → ACCEPTED guarded on the status (the loser of two
   *    approvals, or of an approve racing a decline, gets 400) and clears
   *    `childName`: the name now lives on the roster record.
   *  - SELF: `TeamMember` for the requester, created only when missing.
   *  - CHILD: a managed roster record (`managedById` = the approver, as when a
   *    coach adds the player), its `TeamMember` and the `Guardian` link to the
   *    requester as the child's first, primary guardian; a bare PLAYER
   *    requester becomes PARENT (the guardian accept's rule).
   */
  static async approveRequest(teamId: string, requestId: string, userId: string): Promise<ApproveJoinRequestResult> {
    const { team, request } = await this.requirePendingRequest(teamId, requestId, userId, 'approve');
    const { requesterId } = request;

    const result = await prisma.$transaction(async (tx): Promise<ApproveJoinRequestResult> => {
      const locked = await lockUsers(tx, [requesterId, userId]);
      const live = (id: string): boolean => locked.some((row) => row.id === id && row.deletedAt === null);
      if (!live(userId)) {
        throw new NotFoundError('Account not found');
      }
      if (!live(requesterId)) {
        throw new BadRequestError('The account that sent this request no longer exists');
      }

      const { count } = await tx.teamJoinRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: { status: 'ACCEPTED', decidedAt: new Date(), childName: null },
      });
      if (count === 0) {
        throw new BadRequestError('Cannot approve join request: it is no longer pending');
      }
      const updated = await tx.teamJoinRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: JOIN_REQUEST_SELECT,
      });

      if (request.kind === 'SELF') {
        // Create-if-missing, like the invitation accept: an existing row
        // (and its coach-set jersey) is never overwritten.
        await tx.teamMember.upsert({
          where: { teamId_playerId: { teamId, playerId: requesterId } },
          create: { teamId, playerId: requesterId },
          update: {},
          select: { id: true },
        });
        return { request: updated, playerId: requesterId };
      }

      if (!request.childName || !request.relationship) {
        // A CHILD row always carries both (the schema requires them); a row
        // without them cannot be turned into a roster record.
        throw new BadRequestError('This join request is incomplete. Ask the family to send it again.');
      }
      const child = await tx.user.create({
        data: { name: request.childName, role: 'PLAYER', isManaged: true, managedById: userId, email: null },
        select: { id: true },
      });
      await tx.teamMember.create({ data: { teamId, playerId: child.id }, select: { id: true } });
      // A new record has no guardian yet: this link is its first, so primary.
      await tx.guardian.create({
        data: { parentId: requesterId, childId: child.id, relationship: request.relationship, isPrimary: true },
        select: { id: true },
      });
      const parent = await tx.user.findFirst({ where: { id: requesterId, deletedAt: null }, select: { role: true } });
      if (parent?.role === 'PLAYER') {
        await GuardianService.promoteBareAccountToParent(tx, requesterId);
      }
      return { request: updated, playerId: child.id };
    });

    logger.info('Join request approved', {
      requestId: request.id,
      teamId,
      requesterId,
      playerId: result.playerId,
      kind: request.kind,
      userId,
    });
    await this.notifyRequester(requesterId, teamId, team.name);

    return result;
  }

  /**
   * A roster manager declines a request: one status-guarded update that also
   * clears `childName`. Nothing is written to the roster and the requester is
   * not notified.
   */
  static async declineRequest(teamId: string, requestId: string, userId: string): Promise<JoinRequestSummary> {
    const { request } = await this.requirePendingRequest(teamId, requestId, userId, 'decline');

    const { count } = await prisma.teamJoinRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date(), childName: null },
    });
    if (count === 0) {
      throw new BadRequestError('Cannot decline join request: it is no longer pending');
    }
    const declined = await prisma.teamJoinRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: JOIN_REQUEST_SELECT,
    });

    logger.info('Join request declined', { requestId: request.id, teamId, requesterId: request.requesterId, userId });
    return declined;
  }
}
