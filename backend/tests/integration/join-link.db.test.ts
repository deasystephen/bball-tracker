/**
 * Team join links (#210) against a REAL Postgres.
 *
 * The mocked API suite (`tests/api/join-links.test.ts`) asserts the `where`
 * objects the service writes. Here the database answers:
 *  - creating a link revokes the live one, so a team has exactly one, and two
 *    concurrent creates still end with one;
 *  - a join request grants NOTHING until a coach approves it: the requester
 *    cannot read the team (`canAccessTeam`) while it is pending or after a
 *    decline;
 *  - the conditional use-count UPDATE holds `maxUses` under concurrency;
 *  - an expired link is refused (410) and a revoked one reads as unknown (404),
 *    but a retry by an account whose request already exists is answered with
 *    that request whatever happened to the link since;
 *  - a request nobody decides lapses after JOIN_REQUEST_TTL_DAYS and is
 *    deleted (a coach's decision, the requester's next ask, the list, and the
 *    hourly sweep with nobody reading anything, #1075), which frees the
 *    requester's cap; an account un-claimed into a managed record can
 *    neither ask nor be approved;
 *  - approval writes the roster: SELF adds the member; CHILD creates a managed
 *    record with no login, its membership and the primary guardian link, and
 *    makes a bare PLAYER a PARENT; two concurrent approvals write it once;
 *  - account deletion removes the requester's requests (so the row can be
 *    erased) and un-owns the links a deleted coach created.
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import prisma from '../../src/models';
import { JOIN_REQUEST_TTL_DAYS, JoinLinkService, type JoinLinkView } from '../../src/services/join-link-service';
import { AccountService } from '../../src/services/account-service';
import { NotificationService } from '../../src/services/notification-service';
import { sweepLapsedJoinRequests } from '../../src/services/join-request-sweep';
import { canAccessTeam } from '../../src/utils/permissions';
import { BadRequestError, JoinLinkInactiveError, NotFoundError } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'join-link');
let org: Org;
let headCoachId: string;
let counter = 0;

/** A fresh signed-in adult (PLAYER, the role a new account starts with). */
async function adult(label: string): Promise<string> {
  counter += 1;
  return fx.user(`${label}${counter}`, 'PLAYER');
}

function tokenOf(link: JoinLinkView): string {
  return link.url.slice(link.url.lastIndexOf('/') + 1);
}

/** A fresh team with its own head coach, so link state never leaks between tests. */
async function team(label: string): Promise<{ org: Org; coachId: string }> {
  counter += 1;
  const coachId = await fx.user(`coach-${label}${counter}`, 'COACH');
  const created = await fx.org(`${label}${counter}`);
  await fx.staff(coachId, created);
  return { org: created, coachId };
}

beforeAll(async () => {
  await fx.requireDatabase();
  headCoachId = await fx.user('head', 'COACH');
  org = await fx.org('club');
  await fx.staff(headCoachId, org);
  // No device is registered for these users; the push lookups find nothing.
  jest.spyOn(NotificationService, 'sendToUsers').mockResolvedValue([]);
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('JoinLinkService (real Postgres, #210)', () => {
  it('create revokes the live link: one live link per team, and the old token reads as unknown', async () => {
    const first = await JoinLinkService.createLink(org.teamId, {}, headCoachId);
    const second = await JoinLinkService.createLink(org.teamId, { expiresInDays: 3, maxUses: 10 }, headCoachId);

    expect(tokenOf(first)).not.toBe(tokenOf(second));
    expect(await prisma.teamJoinLink.count({ where: { teamId: org.teamId, revokedAt: null } })).toBe(1);
    const current = await JoinLinkService.getLink(org.teamId, headCoachId);
    expect(current).toMatchObject({ id: second.id, url: second.url, maxUses: 10, useCount: 0 });

    await expect(JoinLinkService.previewByToken(tokenOf(first))).rejects.toBeInstanceOf(NotFoundError);
    await expect(JoinLinkService.previewByToken(tokenOf(second))).resolves.toMatchObject({
      teamName: org.teamName,
      state: 'active',
    });
  });

  it('two concurrent creates still leave exactly one live link', async () => {
    const { org: club, coachId } = await team('race');
    await Promise.all([
      JoinLinkService.createLink(club.teamId, {}, coachId),
      JoinLinkService.createLink(club.teamId, {}, coachId),
      JoinLinkService.createLink(club.teamId, {}, coachId),
    ]);

    expect(await prisma.teamJoinLink.count({ where: { teamId: club.teamId } })).toBe(3);
    expect(await prisma.teamJoinLink.count({ where: { teamId: club.teamId, revokedAt: null } })).toBe(1);
  });

  it('a request grants nothing: no roster row and no read access until a coach approves', async () => {
    const { org: club, coachId } = await team('pending');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const requesterId = await adult('asker');

    const result = await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId);

    expect(result).toMatchObject({ status: 'pending', created: true, teamName: club.teamName });
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId, playerId: requesterId } })).toBe(0);
    expect(await canAccessTeam(requesterId, club.teamId)).toBe(false);
    // A requester cannot see or decide requests either.
    await expect(JoinLinkService.listRequests(club.teamId, requesterId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(JoinLinkService.getLink(club.teamId, requesterId)).rejects.toMatchObject({ statusCode: 403 });

    // Asking again returns the same request and takes no second use.
    const again = await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId);
    expect(again).toMatchObject({ status: 'pending', created: false });
    if (result.status === 'pending' && again.status === 'pending') {
      expect(again.request.id).toBe(result.request.id);
    }
    expect((await prisma.teamJoinLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(1);

    // Declined: still nothing.
    const [listed] = await JoinLinkService.listRequests(club.teamId, coachId);
    expect(listed.requester.id).toBe(requesterId);
    await JoinLinkService.declineRequest(club.teamId, listed.id, coachId);
    expect(await canAccessTeam(requesterId, club.teamId)).toBe(false);
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId } })).toBe(0);
    expect(await JoinLinkService.listRequests(club.teamId, coachId)).toEqual([]);
  });

  it('a double tap by one account creates one request', async () => {
    const { org: club, coachId } = await team('double');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const requesterId = await adult('tapper');

    const results = await Promise.all([
      JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId),
      JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId),
    ]);

    expect(results.filter((r) => r.status === 'pending' && r.created)).toHaveLength(1);
    expect(await prisma.teamJoinRequest.count({ where: { teamId: club.teamId, requesterId } })).toBe(1);
    expect((await prisma.teamJoinLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(1);
  });

  it('holds maxUses under concurrency: the conditional UPDATE lets exactly that many through', async () => {
    const { org: club, coachId } = await team('cap');
    const link = await JoinLinkService.createLink(club.teamId, { maxUses: 2 }, coachId);
    const requesters = await Promise.all([adult('cap'), adult('cap'), adult('cap'), adult('cap')]);

    const settled = await Promise.allSettled(
      requesters.map((id) => JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, id))
    );

    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
    expect(refused).toHaveLength(2);
    for (const { reason } of refused) {
      expect(reason).toBeInstanceOf(JoinLinkInactiveError);
      expect((reason as JoinLinkInactiveError).details.reason).toBe('full');
    }
    expect((await prisma.teamJoinLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(2);
    expect(await prisma.teamJoinRequest.count({ where: { teamId: club.teamId } })).toBe(2);
    await expect(JoinLinkService.previewByToken(tokenOf(link))).resolves.toMatchObject({ state: 'full' });
    // The coach still sees the full link, to understand why nobody can use it.
    expect(await JoinLinkService.getLink(club.teamId, coachId)).toMatchObject({ useCount: 2, maxUses: 2 });
  });

  it('refuses an expired link (410) and treats a revoked one as unknown (404)', async () => {
    const { org: club, coachId } = await team('dead');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const requesterId = await adult('late');

    await prisma.teamJoinLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(JoinLinkService.previewByToken(tokenOf(link))).resolves.toMatchObject({ state: 'expired' });
    await expect(
      JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId)
    ).rejects.toMatchObject({ statusCode: 410, code: 'join_link_inactive', details: { reason: 'expired' } });
    // An expired link is not "the team's live link" any more.
    expect(await JoinLinkService.getLink(club.teamId, coachId)).toBeNull();

    const fresh = await JoinLinkService.createLink(club.teamId, {}, coachId);
    expect(await JoinLinkService.revokeLinks(club.teamId, coachId)).toEqual({ revoked: 1 });
    await expect(JoinLinkService.previewByToken(tokenOf(fresh))).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      JoinLinkService.requestToJoin(tokenOf(fresh), { kind: 'self' }, requesterId)
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.teamJoinRequest.count({ where: { teamId: club.teamId } })).toBe(0);
  });

  it('a retry after the last use was taken returns the existing request, not "link full"', async () => {
    const { org: club, coachId } = await team('retry');
    const link = await JoinLinkService.createLink(club.teamId, { maxUses: 1 }, coachId);
    const first = await adult('first');
    const second = await adult('second');

    const created = await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, first);
    expect(created).toMatchObject({ status: 'pending', created: true });

    // The response was lost and the client retries: the link is full now.
    await expect(JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, first)).resolves.toMatchObject({
      status: 'pending',
      created: false,
    });
    // Someone new is refused, and so is a NEW request (a child) by the first account.
    await expect(JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, second)).rejects.toMatchObject({
      statusCode: 410,
      details: { reason: 'full' },
    });
    await expect(
      JoinLinkService.requestToJoin(
        tokenOf(link),
        { kind: 'child', childName: `Extra-${fx.run}`, relationship: 'OTHER' },
        first
      )
    ).rejects.toMatchObject({ statusCode: 410 });

    // Rotated: the old token is dead for everyone else, the retry still resolves.
    await JoinLinkService.createLink(club.teamId, {}, coachId);
    await expect(JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, first)).resolves.toMatchObject({
      status: 'pending',
      created: false,
    });
    await expect(JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, second)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(await prisma.teamJoinRequest.count({ where: { teamId: club.teamId } })).toBe(1);
  });

  it('a lapsed request a coach tries to decide is deleted and refused (400); a retry is a 404', async () => {
    const { org: club, coachId } = await team('stale');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const parentId = await adult('waiting');
    const childName = `Waiting-${fx.run}`;
    const asked = await JoinLinkService.requestToJoin(
      tokenOf(link),
      { kind: 'child', childName, relationship: 'FATHER' },
      parentId
    );
    if (asked.status !== 'pending') throw new Error('expected a pending request');
    const old = new Date(Date.now() - (JOIN_REQUEST_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.teamJoinRequest.update({ where: { id: asked.request.id }, data: { createdAt: old } });

    // Not swept yet: the coach's approve deletes it and is refused.
    await expect(JoinLinkService.approveRequest(club.teamId, asked.request.id, coachId)).rejects.toMatchObject({
      statusCode: 400,
      message: `Cannot approve this join request: it lapsed after ${JOIN_REQUEST_TTL_DAYS} days`,
    });
    expect(await prisma.teamJoinRequest.findUnique({ where: { id: asked.request.id } })).toBeNull();
    expect(await prisma.user.count({ where: { name: childName } })).toBe(0);
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId, playerId: parentId } })).toBe(0);
    await expect(JoinLinkService.declineRequest(club.teamId, asked.request.id, coachId)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(await JoinLinkService.listRequests(club.teamId, coachId)).toEqual([]);
  });

  it('a requester asking again after a lapse gets a fresh request, with no list read in between', async () => {
    const { org: club, coachId } = await team('again');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const parentId = await adult('returning');
    const childName = `Again-${fx.run}`;
    const asked = await JoinLinkService.requestToJoin(
      tokenOf(link),
      { kind: 'child', childName, relationship: 'FATHER' },
      parentId
    );
    if (asked.status !== 'pending') throw new Error('expected a pending request');
    const old = new Date(Date.now() - (JOIN_REQUEST_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.teamJoinRequest.update({ where: { id: asked.request.id }, data: { createdAt: old } });

    const again = await JoinLinkService.requestToJoin(
      tokenOf(link),
      { kind: 'child', childName, relationship: 'FATHER' },
      parentId
    );
    expect(again).toMatchObject({ status: 'pending', created: true });
    if (again.status !== 'pending') throw new Error('expected a pending request');
    expect(again.request.id).not.toBe(asked.request.id);
    expect(await prisma.teamJoinRequest.findUnique({ where: { id: asked.request.id } })).toBeNull();
    expect(await prisma.teamJoinRequest.count({ where: { teamId: club.teamId, requesterId: parentId } })).toBe(1);
  });

  it('the sweep deletes lapsed and legacy EXPIRED requests nobody reads, and keeps the rest (#1075)', async () => {
    const { org: club, coachId } = await team('sweep');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const day = 24 * 60 * 60 * 1000;
    const longAgo = new Date(Date.now() - (JOIN_REQUEST_TTL_DAYS * day + 60 * 1000));
    async function ask(label: string): Promise<{ id: string; childName: string }> {
      const childName = `${label}-${fx.run}`;
      const asked = await JoinLinkService.requestToJoin(
        tokenOf(link),
        { kind: 'child', childName, relationship: 'MOTHER' },
        await adult(label)
      );
      if (asked.status !== 'pending') throw new Error('expected a pending request');
      return { id: asked.request.id, childName };
    }
    const lapsed = await ask('swept');
    const fresh = await ask('kept');
    const legacy = await ask('legacy');
    const declined = await ask('declined');
    const approved = await ask('approved');
    await prisma.teamJoinRequest.update({ where: { id: lapsed.id }, data: { createdAt: longAgo } });
    // A day short of the mark: not lapsed.
    await prisma.teamJoinRequest.update({
      where: { id: fresh.id },
      data: { createdAt: new Date(Date.now() - (JOIN_REQUEST_TTL_DAYS - 1) * day) },
    });
    // What the lazy path wrote before #1075: EXPIRED, name already cleared.
    await prisma.teamJoinRequest.update({
      where: { id: legacy.id },
      data: { status: 'EXPIRED', decidedAt: new Date(), childName: null },
    });
    // Decided long ago: the sweep leaves decisions alone, however old.
    await JoinLinkService.declineRequest(club.teamId, declined.id, coachId);
    await JoinLinkService.approveRequest(club.teamId, approved.id, coachId);
    await prisma.teamJoinRequest.updateMany({
      where: { id: { in: [declined.id, approved.id] } },
      data: { createdAt: longAgo },
    });

    // No list read, no new ask, no decision: only the sweep.
    expect(await sweepLapsedJoinRequests()).toBeGreaterThanOrEqual(2);

    expect(await prisma.teamJoinRequest.findUnique({ where: { id: lapsed.id } })).toBeNull();
    expect(await prisma.teamJoinRequest.findUnique({ where: { id: legacy.id } })).toBeNull();
    expect(await prisma.teamJoinRequest.count({ where: { childName: lapsed.childName } })).toBe(0);
    expect(await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({
      status: 'PENDING',
      childName: fresh.childName,
    });
    expect(await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: declined.id } })).toMatchObject({
      status: 'REJECTED',
      childName: null,
    });
    expect(await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: approved.id } })).toMatchObject({
      status: 'ACCEPTED',
      childName: null,
    });

    // A second sweep finds nothing of ours left, and the coach sees only the fresh one.
    await sweepLapsedJoinRequests();
    expect((await JoinLinkService.listRequests(club.teamId, coachId)).map((r) => r.id)).toEqual([fresh.id]);
  });

  it('an account un-claimed into a managed record can neither ask nor be approved', async () => {
    const { org: club, coachId } = await team('unclaimed');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const accountId = await adult('young');
    await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, accountId);
    const [pending] = await JoinLinkService.listRequests(club.teamId, coachId);

    // What the un-claim leaves on the row (its purge of the requests is
    // covered below; here the request is left in place on purpose, as a
    // request that slipped in behind the purge would be).
    await prisma.user.update({ where: { id: accountId }, data: { isManaged: true, managedById: coachId } });

    await expect(JoinLinkService.approveRequest(club.teamId, pending.id, coachId)).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId, playerId: accountId } })).toBe(0);
    await expect(
      JoinLinkService.requestToJoin(tokenOf(link), { kind: 'child', childName: `No-${fx.run}`, relationship: 'OTHER' }, accountId)
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('a lapse survives a refused ask: the row stays deleted when the old link is dead', async () => {
    const { org: club, coachId } = await team('lapse');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const parentId = await adult('late');
    const asked = await JoinLinkService.requestToJoin(
      tokenOf(link),
      { kind: 'child', childName: `Old-${fx.run}`, relationship: 'MOTHER' },
      parentId
    );
    if (asked.status !== 'pending') throw new Error('expected a pending request');
    const old = new Date(Date.now() - (JOIN_REQUEST_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.teamJoinRequest.update({ where: { id: asked.request.id }, data: { createdAt: old } });
    await prisma.teamJoinLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    // The parent comes back a month later through the same, now expired, link.
    await expect(
      JoinLinkService.requestToJoin(
        tokenOf(link),
        { kind: 'child', childName: `Second-${fx.run}`, relationship: 'MOTHER' },
        parentId
      )
    ).rejects.toMatchObject({ statusCode: 410 });

    expect(await prisma.teamJoinRequest.findUnique({ where: { id: asked.request.id } })).toBeNull();
  });

  it('an account a coach keeps declining runs into the cap; approved requests never count', async () => {
    const { org: club, coachId } = await team('nagging');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const parentId = await adult('nag');
    const ask = (n: number): ReturnType<typeof JoinLinkService.requestToJoin> =>
      JoinLinkService.requestToJoin(
        tokenOf(link),
        { kind: 'child', childName: `Nag${n}-${fx.run}`, relationship: 'OTHER' },
        parentId
      );

    // One approved (does not count), then six declined.
    await ask(0);
    const [first] = await JoinLinkService.listRequests(club.teamId, coachId);
    await JoinLinkService.approveRequest(club.teamId, first.id, coachId);
    for (let n = 1; n <= 6; n += 1) {
      await ask(n);
      const [pending] = await JoinLinkService.listRequests(club.teamId, coachId);
      await JoinLinkService.declineRequest(club.teamId, pending.id, coachId);
    }

    await expect(ask(7)).rejects.toBeInstanceOf(BadRequestError);
    expect((await prisma.teamJoinLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(7);
  });

  it('approving a SELF request adds the member once; a second approval is refused', async () => {
    const { org: club, coachId } = await team('self');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const requesterId = await adult('player');
    await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId);
    const [pending] = await JoinLinkService.listRequests(club.teamId, coachId);

    const approved = await JoinLinkService.approveRequest(club.teamId, pending.id, coachId);

    expect(approved).toMatchObject({ playerId: requesterId, request: { status: 'ACCEPTED', kind: 'SELF' } });
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId, playerId: requesterId } })).toBe(1);
    expect(await canAccessTeam(requesterId, club.teamId)).toBe(true);
    // A player who joined as themself stays a PLAYER with their own login.
    expect(await prisma.user.findUniqueOrThrow({ where: { id: requesterId } })).toMatchObject({
      role: 'PLAYER',
      isManaged: false,
    });
    await expect(JoinLinkService.approveRequest(club.teamId, pending.id, coachId)).rejects.toBeInstanceOf(
      BadRequestError
    );
    await expect(JoinLinkService.declineRequest(club.teamId, pending.id, coachId)).rejects.toBeInstanceOf(
      BadRequestError
    );
    // Opening the link again is a no-op for a member.
    await expect(JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId)).resolves.toEqual({
      status: 'already_member',
      teamId: club.teamId,
      teamName: club.teamName,
    });
    expect((await prisma.teamJoinLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(1);
  });

  it('approving a CHILD request creates a managed roster record with a primary guardian, never a login', async () => {
    const { org: club, coachId } = await team('child');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const parentId = await adult('parent');
    const childName = `Kid-${fx.run}`;
    const siblingName = `Sibling-${fx.run}`;

    await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'child', childName, relationship: 'MOTHER' }, parentId);
    await JoinLinkService.requestToJoin(
      tokenOf(link),
      { kind: 'child', childName: siblingName, relationship: 'MOTHER' },
      parentId
    );
    const pending = await JoinLinkService.listRequests(club.teamId, coachId);
    expect(pending.map((r) => r.childName).sort()).toEqual([childName, siblingName].sort());
    const request = pending.find((r) => r.childName === childName)!;

    const approved = await JoinLinkService.approveRequest(club.teamId, request.id, coachId);

    const child = await prisma.user.findUniqueOrThrow({ where: { id: approved.playerId } });
    expect(child).toMatchObject({
      name: childName,
      role: 'PLAYER',
      isManaged: true,
      managedById: coachId,
      email: null,
      workosUserId: null,
      ageConfirmedAt: null,
    });
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId, playerId: child.id } })).toBe(1);
    expect(await prisma.guardian.findMany({ where: { childId: child.id } })).toEqual([
      expect.objectContaining({ parentId, relationship: 'MOTHER', isPrimary: true }),
    ]);
    // The parent is not on the roster, becomes PARENT and reads the team as a guardian.
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId, playerId: parentId } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: parentId } })).role).toBe('PARENT');
    expect(await canAccessTeam(parentId, club.teamId)).toBe(true);
    // The typed name left the request row once it was decided.
    expect(await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
      status: 'ACCEPTED',
      childName: null,
    });

    // The same child again is a no-op; the sibling is still waiting.
    await expect(
      JoinLinkService.requestToJoin(
        tokenOf(link),
        { kind: 'child', childName: childName.toUpperCase(), relationship: 'MOTHER' },
        parentId
      )
    ).resolves.toMatchObject({ status: 'already_member' });
    expect(await JoinLinkService.listRequests(club.teamId, coachId)).toHaveLength(1);
  });

  it('two coaches approving one CHILD request at once create one roster record', async () => {
    const { org: club, coachId } = await team('twice');
    const secondCoachId = await fx.user(`second-coach${counter}`, 'COACH');
    await fx.staff(secondCoachId, club);
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const parentId = await adult('parent');
    const childName = `Once-${fx.run}`;
    await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'child', childName, relationship: 'FATHER' }, parentId);
    const [request] = await JoinLinkService.listRequests(club.teamId, coachId);

    const settled = await Promise.allSettled([
      JoinLinkService.approveRequest(club.teamId, request.id, coachId),
      JoinLinkService.approveRequest(club.teamId, request.id, secondCoachId),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const [lost] = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(lost.reason).toBeInstanceOf(BadRequestError);
    expect(await prisma.user.count({ where: { name: childName } })).toBe(1);
    expect(await prisma.teamMember.count({ where: { teamId: club.teamId } })).toBe(1);
    expect(await prisma.guardian.count({ where: { parentId } })).toBe(1);
  });

  it('a request id from another team is not found, whoever asks', async () => {
    const { org: club, coachId } = await team('mine');
    const { org: other, coachId: otherCoachId } = await team('theirs');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const requesterId = await adult('asker');
    await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId);
    const [request] = await JoinLinkService.listRequests(club.teamId, coachId);

    // The other team's coach manages their own roster, not this request.
    await expect(JoinLinkService.approveRequest(other.teamId, request.id, otherCoachId)).rejects.toBeInstanceOf(
      NotFoundError
    );
    await expect(JoinLinkService.approveRequest(club.teamId, request.id, otherCoachId)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await prisma.teamMember.count({ where: { playerId: requesterId } })).toBe(0);
  });

  it('account deletion removes the requester\'s requests, so a sign-up that only asked is erased', async () => {
    const { org: club, coachId } = await team('gone');
    const link = await JoinLinkService.createLink(club.teamId, {}, coachId);
    const requesterId = await adult('leaver');
    await JoinLinkService.requestToJoin(
      tokenOf(link),
      { kind: 'child', childName: `Unseen-${fx.run}`, relationship: 'GUARDIAN' },
      requesterId
    );
    const [request] = await JoinLinkService.listRequests(club.teamId, coachId);

    const exported = await AccountService.exportUserData(requesterId);
    expect(exported.joinRequests).toEqual([
      expect.objectContaining({ id: request.id, kind: 'CHILD', childName: `Unseen-${fx.run}`, status: 'PENDING' }),
    ]);

    const result = await AccountService.deleteAccount(requesterId, { actorId: requesterId, mode: 'self' });

    expect(result.erased).toBe(true);
    expect(await prisma.teamJoinRequest.count({ where: { id: request.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: requesterId } })).toBe(0);
    // Nothing is left for the coach to approve.
    await expect(JoinLinkService.approveRequest(club.teamId, request.id, coachId)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('a deleted coach\'s link stays usable and no longer points at them', async () => {
    const { org: club, coachId } = await team('owner');
    const assistantId = await fx.user(`assistant${counter}`, 'COACH');
    await fx.staff(assistantId, club);
    const link = await JoinLinkService.createLink(club.teamId, {}, assistantId);

    // The export lists the link the coach created, never its token.
    const exported = await AccountService.exportUserData(assistantId);
    expect(exported.createdJoinLinks).toEqual([expect.objectContaining({ id: link.id, teamId: club.teamId })]);
    expect(JSON.stringify(exported)).not.toContain(tokenOf(link));

    await AccountService.deleteAccount(assistantId, { actorId: assistantId, mode: 'self' });

    expect(await prisma.teamJoinLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({
      createdById: null,
      revokedAt: null,
    });
    // Requests through it are still decided by a current roster manager.
    const requesterId = await adult('after');
    await JoinLinkService.requestToJoin(tokenOf(link), { kind: 'self' }, requesterId);
    expect(await JoinLinkService.listRequests(club.teamId, coachId)).toHaveLength(1);
  });
});
