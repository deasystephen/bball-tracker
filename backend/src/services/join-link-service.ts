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
 *    Or (#1072) the coach links the request to an existing managed record of
 *    the team that has no guardian yet, instead of creating a duplicate.
 *
 * The token is a bearer secret. It is read only through
 * `JOIN_LINK_MANAGER_SELECT`, returned only to roster managers (as the URL
 * they share), and never logged. A revoked link answers 404 like an unknown
 * one, so a rotated link tells its holder nothing.
 *
 * Detail: docs/architecture/roster-and-invitations.md, Team join links.
 */

import { JoinRequestKind, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import prisma from '../models';
import {
  BadRequestError,
  ForbiddenError,
  JoinLinkInactiveError,
  JoinPlayerUnavailableError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/errors';
import { hasTeamPermission } from '../utils/permissions';
import { lockTeamRow } from '../utils/team-row-lock';
import { lockUsers } from '../utils/user-row-lock';
import { logger } from '../utils/logger';
import { publicAppUrl } from '../utils/urls';
import { USER_SUMMARY_WITH_EMAIL_SELECT } from '../utils/user-select';
import { GuardianService } from './guardian-service';
import { NotificationService } from './notification-service';
import type { ApproveJoinRequestInput, CreateJoinLinkInput, JoinRequestInput } from '../api/join/schemas';

/** A link nobody rotates dies by itself: the default lifetime when the coach picks none. */
export const JOIN_LINK_DEFAULT_EXPIRES_DAYS = 14;

/**
 * Requests one account may have open on one team (itself plus children):
 * those still PENDING plus those a coach DECLINED within the last
 * `JOIN_REQUEST_TTL_DAYS`. Counting the declined ones is what stops an
 * account from asking again and again after a "no", each ask a push to the
 * coaches and a use of the link; approved requests never count, so a family
 * with many children is slowed only while the coach has not answered.
 */
export const MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT = 6;

/**
 * A request nobody decides lapses: after this many days it is flipped to
 * EXPIRED and its `childName` cleared, lazily, the next time the team's list
 * is read or the requester asks again (nothing in this API is scheduled). So
 * a family is never stuck at the pending cap, and a typed child's name does
 * not wait on a coach forever.
 */
export const JOIN_REQUEST_TTL_DAYS = 30;

const JOIN_LINK_NOT_FOUND = 'Join link not found';
const JOIN_REQUEST_NOT_FOUND = 'Join request not found';
const NO_ROSTER_PERMISSION = "You do not have permission to manage this team's roster";

/**
 * Scalar fields of a link that carry no secret. The stored `useCount` (every
 * request ever created through the link) is deliberately not read: the cap and
 * every payload count the requests holding a slot now (`countUses`, #1073).
 */
const JOIN_LINK_SELECT = {
  id: true,
  teamId: true,
  expiresAt: true,
  maxUses: true,
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

/** The requester's own pending rows, with the name the dedupe compares. Never returned as is. */
const JOIN_REQUEST_DEDUPE_SELECT = {
  ...JOIN_REQUEST_SELECT,
  childName: true,
} satisfies Prisma.TeamJoinRequestSelect;

/** What a decision reads of the request before it locks anything. */
const JOIN_REQUEST_DECISION_SELECT = {
  id: true,
  requesterId: true,
  kind: true,
  childName: true,
  relationship: true,
  status: true,
  createdAt: true,
} satisfies Prisma.TeamJoinRequestSelect;

/** The names of the children an account guards, for the already-on-the-roster check. */
const GUARDED_CHILD_NAME_SELECT = {
  child: { select: { name: true, deletedAt: true } },
} satisfies Prisma.GuardianSelect;

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
type JoinRequestDecisionRow = Prisma.TeamJoinRequestGetPayload<{ select: typeof JOIN_REQUEST_DECISION_SELECT }>;

/**
 * The team's live link for a roster manager. `url` carries the token; there is
 * no separate token field. `useCount` is the number of requests that hold one
 * of the link's `maxUses` slots now (`countUses`, pending plus approved), not
 * the stored `TeamJoinLink.useCount` column, which counts every request ever
 * created through the link.
 */
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
  /**
   * The roster record the approval wrote or linked: the requester (SELF), the
   * new managed child (CHILD), or the existing record the coach chose (CHILD
   * with `playerId`, #1072).
   */
  playerId: string;
  /** True when a CHILD request was linked to an existing roster record instead of creating one. */
  linkedExisting: boolean;
}

function toView(row: JoinLinkManagerRow, used: number): JoinLinkView {
  const { token, ...rest } = row;
  return { ...rest, useCount: used, url: `${publicAppUrl()}/join/${token}` };
}

function linkState(row: Pick<JoinLinkPublicRow, 'expiresAt' | 'maxUses'>, used: number, now: Date): JoinLinkState {
  if (row.expiresAt <= now) {
    return 'expired';
  }
  if (row.maxUses !== null && used >= row.maxUses) {
    return 'full';
  }
  return 'active';
}

/** The moment before which a PENDING request has lapsed. */
function staleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - JOIN_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The requests that hold one of a link's `maxUses` slots (#1073): PENDING and
 * not yet lapsed, or ACCEPTED (approved). A declined (REJECTED) or lapsed
 * (EXPIRED, or PENDING past `JOIN_REQUEST_TTL_DAYS` and not flipped yet)
 * request frees its slot; CANCELLED is never written for a join request; a
 * request deleted with its requester's account frees its slot too.
 */
function slotHoldersWhere(linkId: string, now: Date): Prisma.TeamJoinRequestWhereInput {
  return {
    linkId,
    OR: [{ status: 'ACCEPTED' }, { status: 'PENDING', createdAt: { gte: staleBefore(now) } }],
  };
}

/** How many of a link's `maxUses` slots are taken now (see `slotHoldersWhere`). */
async function countUses(
  client: Prisma.TransactionClient | typeof prisma,
  linkId: string,
  now: Date = new Date()
): Promise<number> {
  return client.teamJoinRequest.count({ where: slotHoldersWhere(linkId, now) });
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
   * The roster-manager gate again, inside a transaction that holds the team
   * row lock every staff removal and re-role takes: a coach removed while the
   * call was in flight has either committed (seen here, 403) or waits for
   * this transaction. Read through `tx`, so no second pool connection.
   */
  private static async assertStillRosterManager(
    tx: Prisma.TransactionClient,
    teamId: string,
    userId: string
  ): Promise<void> {
    if (!(await hasTeamPermission(userId, teamId, 'canManageRoster', tx))) {
      throw new ForbiddenError(NO_ROSTER_PERMISSION);
    }
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
      await this.assertStillRosterManager(tx, teamId, userId);
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

    // A new link has no requests yet.
    return toView(link, 0);
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
    return link ? toView(link, await countUses(prisma, link.id)) : null;
  }

  /**
   * Revoke every live link of the team (gate `canManageRoster`). Requests
   * already waiting stay for the coach to decide: families who asked through
   * the link before it leaked are not thrown away with it.
   */
  static async revokeLinks(teamId: string, userId: string): Promise<{ revoked: number }> {
    await this.requireRosterManager(teamId, userId);
    // Behind the team row lock `createLink` holds: a revoke that races a
    // create waits for it and then revokes the link it inserted, instead of
    // answering "revoked" while a link it never saw stays live.
    const count = await prisma.$transaction(async (tx) => {
      if (!(await lockTeamRow(tx, teamId))) {
        throw new NotFoundError('Team not found');
      }
      await this.assertStillRosterManager(tx, teamId, userId);
      const revoked = await tx.teamJoinLink.updateMany({
        where: { teamId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return revoked.count;
    });
    logger.info('Join link revoked', { teamId, userId, revokedCount: count });
    return { revoked: count };
  }

  /** The link behind a token, revoked or not; 404 when there is none. */
  private static async findLink(token: string): Promise<JoinLinkPublicRow> {
    const link = await prisma.teamJoinLink.findUnique({ where: { token }, select: JOIN_LINK_PUBLIC_SELECT });
    if (!link) {
      throw new NotFoundError(JOIN_LINK_NOT_FOUND);
    }
    return link;
  }

  /**
   * Lazy expiry of requests nobody decided within `JOIN_REQUEST_TTL_DAYS`:
   * EXPIRED, and the typed child's name cleared. Runs where pending requests
   * are read (the team's list, the requester's next ask), as a statement of
   * its own and never inside the caller's transaction: a refusal that rolls
   * the ask back must not bring the name back, nor leave a log line for an
   * expiry that did not happen.
   */
  private static async expireStaleRequests(
    where: Pick<Prisma.TeamJoinRequestWhereInput, 'teamId' | 'requesterId'>
  ): Promise<void> {
    const { count } = await prisma.teamJoinRequest.updateMany({
      where: { ...where, status: 'PENDING', createdAt: { lt: staleBefore() } },
      data: { status: 'EXPIRED', decidedAt: new Date(), childName: null },
    });
    if (count > 0) {
      logger.info('Join requests expired', { teamId: where.teamId, expiredCount: count });
    }
  }

  /**
   * Public, unauthenticated preview (web `/join/<token>` page, app deep
   * link): the team's name and the link's state only. No roster, no coach, no
   * counts. `linkId` is for the caller's log line, never for the response.
   */
  static async previewByToken(token: string): Promise<JoinLinkPreview & { linkId: string }> {
    const link = await this.findLink(token);
    // A revoked link reads as unknown: a rotated link tells its holder nothing.
    if (link.revokedAt !== null) {
      throw new NotFoundError(JOIN_LINK_NOT_FOUND);
    }
    return { linkId: link.id, teamName: link.team.name, state: await this.currentState(link) };
  }

  /**
   * The link's state for a holder. Counts the slots only when there is a cap
   * and the link has not expired (an uncapped link never reads its requests).
   */
  private static async currentState(
    link: Pick<JoinLinkPublicRow, 'id' | 'expiresAt' | 'maxUses'>,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<JoinLinkState> {
    const now = new Date();
    const used = link.maxUses !== null && link.expiresAt > now ? await countUses(client, link.id, now) : 0;
    return linkState(link, used, now);
  }

  /**
   * A signed-in account asks to join through the link. One transaction,
   * behind the requester's `User` row lock (so a double tap creates one
   * request and account deletion or an un-claim never leaves a request
   * behind; an account that is no longer a login is refused, 401).
   *
   * Idempotent, and the idempotent answers come BEFORE the link's state is
   * judged: an account (or a child it guards, matched by name) already on the
   * roster answers `already_member` and writes nothing, and a request already
   * waiting is returned as it is, even when the link has since filled,
   * expired or been rotated. A retry after a lost response is therefore never
   * told to ask the coach for a new link. Only a NEW request needs a live
   * link (404 revoked, 410 expired or full), then:
   *  - the per-account cap (pending plus recently declined);
   *  - the link's row lock, taken by a conditional UPDATE (not revoked, not
   *    expired) that also adds one to the stored `useCount` total; then,
   *    behind that lock and in a statement of its own (so it sees every
   *    request committed by a caller that held the lock before), the cap:
   *    `maxUses` counts the link's pending plus approved requests (#1073), so
   *    two callers asking for the last slot leave exactly one request;
   *  - the PENDING request.
   * Nothing is added to the roster here; a roster manager decides.
   */
  static async requestToJoin(token: string, data: JoinRequestInput, userId: string): Promise<JoinRequestResult> {
    const link = await this.findLink(token);
    const teamId = link.teamId;
    const teamName = link.team.name;
    const kind: JoinRequestKind = data.kind === 'child' ? 'CHILD' : 'SELF';
    const childName = data.kind === 'child' ? data.childName : null;

    // Committed before the ask is judged (see expireStaleRequests).
    await this.expireStaleRequests({ teamId, requesterId: userId });

    const result = await prisma.$transaction(async (tx): Promise<JoinRequestResult> => {
      await lockUsers(tx, [userId]);
      // Read after the lock: deleted, or un-claimed back into a managed roster
      // record (the under-age branch, the operator conversion), the account is
      // no longer a login and its requests were purged with it.
      const requester = await tx.user.findFirst({
        where: { id: userId, deletedAt: null, isManaged: false },
        select: { id: true },
      });
      if (!requester) {
        throw new UnauthorizedError('This account can no longer sign in');
      }

      const pending = await tx.teamJoinRequest.findMany({
        where: { teamId, requesterId: userId, status: 'PENDING', createdAt: { gte: staleBefore() } },
        select: JOIN_REQUEST_DEDUPE_SELECT,
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
          select: GUARDED_CHILD_NAME_SELECT,
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

      // From here on a NEW request would be written, which needs a live link.
      if (link.revokedAt !== null) {
        throw new NotFoundError(JOIN_LINK_NOT_FOUND);
      }
      // Unlocked first look, so a link that is plainly full answers 410 before
      // the per-account cap; the authoritative count is taken under the lock.
      const state = await this.currentState(link, tx);
      if (state !== 'active') {
        throw new JoinLinkInactiveError(state);
      }
      const recentlyDeclined = await tx.teamJoinRequest.count({
        where: { teamId, requesterId: userId, status: 'REJECTED', decidedAt: { gte: staleBefore() } },
      });
      if (pending.length + recentlyDeclined >= MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT) {
        throw new BadRequestError(
          'You have sent several requests to this team already. Talk to the coach before sending another.'
        );
      }

      // The link's row lock, taken by the UPDATE that adds to the stored
      // total: a link revoked or expired since the unlocked read above
      // matches no row (Postgres re-checks the row after waiting for the
      // lock). The columns are TIMESTAMP(3) holding UTC (as Prisma writes
      // them), so the comparison is made in UTC whatever the session's time
      // zone is. The conflicting lock is the one another ask holds, so two
      // asks through one link run their cap check one after the other.
      const taken = await tx.$executeRaw`
        UPDATE "TeamJoinLink"
        SET "useCount" = "useCount" + 1, "updatedAt" = (NOW() AT TIME ZONE 'UTC')
        WHERE "id" = ${link.id}
          AND "revokedAt" IS NULL
          AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')`;
      if (taken === 0) {
        const fresh = await tx.teamJoinLink.findUnique({ where: { id: link.id }, select: JOIN_LINK_PUBLIC_SELECT });
        if (!fresh || fresh.revokedAt !== null) {
          throw new NotFoundError(JOIN_LINK_NOT_FOUND);
        }
        throw new JoinLinkInactiveError('expired');
      }
      // The cap, behind the lock, in a new statement: under READ COMMITTED it
      // sees every request committed by an ask that held the lock before this
      // one. `maxUses` never changes after the link is created, so the value
      // read above is current. A refusal rolls the stored total back with it.
      if (link.maxUses !== null && (await countUses(tx, link.id)) >= link.maxUses) {
        throw new JoinLinkInactiveError('full');
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
      await this.notifyRosterManagers(teamId, teamName, userId);
    }

    return result;
  }

  /**
   * Best-effort push to the team's roster managers: a request is waiting. No
   * name in the push (lock screens); the app lists the requests. The
   * requester is left out (a coach adding their own child is not told that
   * "someone" asked). A failed push never fails the request.
   */
  private static async notifyRosterManagers(teamId: string, teamName: string, requesterId: string): Promise<void> {
    try {
      const managers = await prisma.teamStaff.findMany({
        where: { teamId, role: { canManageRoster: true }, userId: { not: requesterId } },
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

  /**
   * Best-effort push to the requester once a coach approved. A parent is told
   * their child was added (no name: lock screens), never that they joined.
   */
  private static async notifyRequester(
    requesterId: string,
    teamId: string,
    teamName: string,
    kind: JoinRequestKind
  ): Promise<void> {
    try {
      await NotificationService.sendToUsers([requesterId], {
        title: 'Request approved',
        body:
          kind === 'CHILD'
            ? `Your child has been added to ${teamName}.`
            : `You have been added to ${teamName}.`,
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
    await this.expireStaleRequests({ teamId });
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
  ): Promise<{ team: { id: string; name: string }; request: JoinRequestDecisionRow }> {
    const team = await this.requireRosterManager(teamId, userId);
    const request = await prisma.teamJoinRequest.findFirst({
      where: { id: requestId, teamId },
      select: JOIN_REQUEST_DECISION_SELECT,
    });
    if (!request) {
      throw new NotFoundError(JOIN_REQUEST_NOT_FOUND);
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestError(`Cannot ${verb} a join request with status: ${request.status}`);
    }
    if (request.createdAt < staleBefore()) {
      // Lapsed but not yet flipped (nobody read the list since): the same
      // answer the list's lazy expiry would have produced.
      throw new BadRequestError(`Cannot ${verb} a join request with status: EXPIRED`);
    }
    return { team, request };
  }

  /**
   * A roster manager approves a request: the roster is written here, in one
   * transaction.
   *  - Locks the requester and the approver (`lockUsers`, one id-ordered
   *    statement): a requester deleted or un-claimed into a managed record
   *    never gets a membership or a guardian link (its requests were removed
   *    with the login), and a deleted approver never becomes a child's
   *    `managedById`.
   *  - Flips PENDING → ACCEPTED guarded on the status (the loser of two
   *    approvals, or of an approve racing a decline, gets 400) and clears
   *    `childName`: the name now lives on the roster record.
   *  - SELF: `TeamMember` for the requester, created only when missing.
   *  - CHILD: a managed roster record (`managedById` = the approver, as when a
   *    coach adds the player), its `TeamMember` and the `Guardian` link to the
   *    requester as the child's first, primary guardian; a bare PLAYER
   *    requester becomes PARENT (the guardian accept's rule).
   *  - CHILD with `playerId` (#1072): no new record. The coach chose one of
   *    the team's existing managed records, and the requester becomes its
   *    guardian (`GuardianService.linkGuardianLocked`, the guardian accept's
   *    code). That record is locked in the SAME `lockUsers` statement as the
   *    requester and the approver (User rows before Team, one id-ordered
   *    statement, the order the guardian accept and account deletion use),
   *    and re-judged behind every lock: still a live managed record, still on
   *    this team, still without a guardian, else 409
   *    `join_player_unavailable` and nothing is written. Two approvals onto
   *    one record therefore leave exactly one guardian link.
   */
  static async approveRequest(
    teamId: string,
    requestId: string,
    userId: string,
    data: ApproveJoinRequestInput = {}
  ): Promise<ApproveJoinRequestResult> {
    const { team, request } = await this.requirePendingRequest(teamId, requestId, userId, 'approve');
    const { requesterId } = request;
    const targetPlayerId = data.playerId ?? null;
    if (targetPlayerId !== null && request.kind !== 'CHILD') {
      throw new BadRequestError('Only a request for a child can be linked to an existing player');
    }

    const result = await prisma.$transaction(async (tx): Promise<ApproveJoinRequestResult> => {
      const locked = await lockUsers(tx, targetPlayerId ? [requesterId, userId, targetPlayerId] : [requesterId, userId]);
      if (!locked.some((row) => row.id === userId && row.deletedAt === null)) {
        throw new NotFoundError('Account not found');
      }
      // The approver's right again, behind the team row lock every staff
      // removal and re-role takes (User rows first, then the team: account
      // deletion's order). A coach removed while this call was in flight has
      // either committed (seen by this read) or waits for this transaction.
      if (!(await lockTeamRow(tx, teamId))) {
        throw new NotFoundError('Team not found');
      }
      await this.assertStillRosterManager(tx, teamId, userId);
      // Read after the lock, like the request: a requester deleted or
      // un-claimed into a managed record meanwhile is no longer a login, and
      // gets no membership and no guardian link.
      const requester = await tx.user.findFirst({
        where: { id: requesterId, deletedAt: null, isManaged: false },
        select: { role: true },
      });
      if (!requester) {
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
        return { request: updated, playerId: requesterId, linkedExisting: false };
      }

      if (!request.childName || !request.relationship) {
        // A CHILD row always carries both (the schema requires them); a row
        // without them cannot be turned into a roster record.
        throw new BadRequestError('This join request is incomplete. Ask the family to send it again.');
      }
      if (targetPlayerId !== null) {
        await this.assertAttachable(tx, teamId, targetPlayerId);
        await GuardianService.linkGuardianLocked(
          tx,
          { parentId: requesterId, childId: targetPlayerId, relationship: request.relationship },
          requester.role
        );
        return { request: updated, playerId: targetPlayerId, linkedExisting: true };
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
      if (requester.role === 'PLAYER') {
        await GuardianService.promoteBareAccountToParent(tx, requesterId);
      }
      return { request: updated, playerId: child.id, linkedExisting: false };
    });

    logger.info('Join request approved', {
      requestId: request.id,
      teamId,
      requesterId,
      playerId: result.playerId,
      kind: request.kind,
      linkedExisting: result.linkedExisting,
      userId,
    });
    // A coach who approved their own request needs no push about it.
    if (requesterId !== userId) {
      await this.notifyRequester(requesterId, teamId, team.name, request.kind);
    }

    return result;
  }

  /**
   * Whether the roster record a coach chose can take a CHILD request (#1072),
   * judged inside the approval's transaction, behind the record's row lock:
   * a live managed record (not a login, not deleted), a member of this team,
   * with no guardian linked yet (a child with any link has exactly one
   * primary, so "no guardian" is "no primary guardian"). 409
   * `join_player_unavailable` otherwise, which rolls the approval back.
   */
  private static async assertAttachable(tx: Prisma.TransactionClient, teamId: string, playerId: string): Promise<void> {
    const player = await tx.user.findFirst({
      where: { id: playerId, deletedAt: null, isManaged: true },
      select: { id: true },
    });
    if (!player) {
      throw new JoinPlayerUnavailableError('not_managed');
    }
    const member = await tx.teamMember.findUnique({
      where: { teamId_playerId: { teamId, playerId } },
      select: { id: true },
    });
    if (!member) {
      throw new JoinPlayerUnavailableError('not_on_team');
    }
    if ((await tx.guardian.count({ where: { childId: playerId } })) > 0) {
      throw new JoinPlayerUnavailableError('has_guardian');
    }
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
