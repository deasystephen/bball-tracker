/**
 * One jersey number per team (#1087) against a REAL Postgres.
 *
 * Add Player, sending an invitation with a number and "Edit jersey & position"
 * refuse a number another current member wears (409 `jersey_number_taken`,
 * naming the holder). Blank is always allowed, `0` is a number like any other
 * and keeping one's own number is a no-op. Two concurrent adds of one number
 * serialise on the team row lock, so exactly one wins. Accepting an invitation
 * never fails over a number: when another member took it after the invitation
 * went out, the person joins with no number (by id and by token).
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomBytes } from 'node:crypto';
import prisma from '../../src/models';
import { InvitationService } from '../../src/services/invitation-service';
import { TeamService } from '../../src/services/team-service';
import { JerseyNumberTakenError } from '../../src/utils/errors';
import { backendPid, pause, track, waitForBlockedBy, type Tracked } from '../support/db-locks';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { spyOnInfo } from '../support/domain-events';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'jersey-number');
const DAY_MS = 24 * 60 * 60 * 1000;

let coachId: string;

/** A fresh team the coach manages, so each test owns its numbers. */
async function team(key: string): Promise<Org> {
  const org = await fx.org(key);
  await fx.staff(coachId, org);
  return org;
}

/** A current member of `org` wearing `jerseyNumber`. */
async function wearer(key: string, org: Org, jerseyNumber: number | null): Promise<string> {
  const playerId = await fx.user(key, 'PLAYER');
  await prisma.teamMember.create({ data: { teamId: org.teamId, playerId, jerseyNumber } });
  return playerId;
}

async function numberOf(org: Org, playerId: string): Promise<number | null | undefined> {
  const row = await prisma.teamMember.findUnique({
    where: { teamId_playerId: { teamId: org.teamId, playerId } },
    select: { jerseyNumber: true },
  });
  return row?.jerseyNumber;
}

async function wearers(org: Org, jerseyNumber: number): Promise<number> {
  return prisma.teamMember.count({ where: { teamId: org.teamId, jerseyNumber } });
}

/** A PENDING invitation for a claimed account (case 3: its member row is born at accept). */
async function invitation(org: Org, key: string, jerseyNumber: number): Promise<{ playerId: string; id: string; token: string }> {
  const playerId = await fx.user(key, 'PLAYER');
  await prisma.user.update({ where: { id: playerId }, data: { workosUserId: `workos-${key}-${fx.run}` } });
  const token = randomBytes(32).toString('base64url');
  const row = await prisma.teamInvitation.create({
    data: {
      teamId: org.teamId,
      playerId,
      invitedById: coachId,
      token,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      jerseyNumber,
      position: 'Guard',
    },
    select: { id: true },
  });
  return { playerId, id: row.id, token };
}

function expectTaken(err: unknown, jerseyNumber: number, holderId: string, holderKey: string): void {
  expect(err).toBeInstanceOf(JerseyNumberTakenError);
  expect((err as JerseyNumberTakenError).statusCode).toBe(409);
  expect((err as JerseyNumberTakenError).body()).toEqual({
    error: `Another player on this team already wears number ${jerseyNumber}.`,
    code: 'jersey_number_taken',
    jerseyNumber,
    playerId: holderId,
    playerName: `${holderKey}-${fx.run}`,
    playerDeletedAt: null,
  });
}

beforeAll(async () => {
  await fx.requireDatabase();
  coachId = await fx.user('coach', 'COACH');
});

beforeEach(() => {
  spyOnInfo();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('Add Player (POST /teams/:teamId/players)', () => {
  it('refuses a number another member wears, naming them, and writes nothing', async () => {
    const org = await team('add-taken');
    const holderId = await wearer('add-holder', org, 8);

    const err = await InvitationService.addRosterPlayer(
      org.teamId,
      { name: `add-dup-${fx.run}`, jerseyNumber: 8 },
      coachId
    ).catch((e: unknown) => e);

    expectTaken(err, 8, holderId, 'add-holder');
    expect(await prisma.teamMember.count({ where: { teamId: org.teamId } })).toBe(1);
  });

  it('refuses a duplicate 0 (a number, not blank) on the invited case too', async () => {
    const org = await team('add-zero');
    const holderId = await wearer('zero-holder', org, 0);

    const err = await InvitationService.addRosterPlayer(
      org.teamId,
      { name: `zero-dup-${fx.run}`, playerEmail: `zero-dup.${fx.run}@example.test`, jerseyNumber: 0 },
      coachId
    ).catch((e: unknown) => e);

    expectTaken(err, 0, holderId, 'zero-holder');
    expect(await prisma.teamInvitation.count({ where: { teamId: org.teamId } })).toBe(0);
  });

  it('a deleted account\'s roster entry still holds its number, and the body says it is deleted', async () => {
    const org = await team('add-tombstone');
    const holderId = await wearer('tomb-holder', org, 31);
    const deletedAt = new Date();
    await prisma.user.update({ where: { id: holderId }, data: { deletedAt } });

    const err = await InvitationService.addRosterPlayer(
      org.teamId,
      { name: `tomb-dup-${fx.run}`, jerseyNumber: 31 },
      coachId
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JerseyNumberTakenError);
    expect((err as JerseyNumberTakenError).body()).toMatchObject({ playerId: holderId, playerDeletedAt: deletedAt });
  });

  it('always allows blank, however many members have no number', async () => {
    const org = await team('add-blank');
    await wearer('blank-holder', org, null);

    const added = await InvitationService.addRosterPlayer(org.teamId, { name: `blank-new-${fx.run}` }, coachId);

    expect(added.member?.jerseyNumber).toBeNull();
    expect(await prisma.teamMember.count({ where: { teamId: org.teamId, jerseyNumber: null } })).toBe(2);
  });

  it('allows a number no one on this team wears, even when another team uses it', async () => {
    const org = await team('add-free');
    const other = await team('add-free-other');
    await wearer('other-team-holder', other, 8);

    const added = await InvitationService.addRosterPlayer(
      org.teamId,
      { name: `free-new-${fx.run}`, jerseyNumber: 8 },
      coachId
    );

    expect(added.member?.jerseyNumber).toBe(8);
  });

  it('two concurrent adds of one number serialise on the team lock: exactly one wins', async () => {
    const org = await team('add-race');
    let first: Tracked<unknown> | undefined;
    let second: Tracked<unknown> | undefined;

    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${org.teamId} FOR NO KEY UPDATE`;
        first = track(InvitationService.addRosterPlayer(org.teamId, { name: `race-a-${fx.run}`, jerseyNumber: 23 }, coachId));
        second = track(InvitationService.addRosterPlayer(org.teamId, { name: `race-b-${fx.run}`, jerseyNumber: 23 }, coachId));
        first.promise.catch(() => undefined);
        second.promise.catch(() => undefined);

        // Both passed the unlocked pre-check and now wait on the lock: without
        // it, both would insert number 23. The first waits on the holder; the
        // second queues behind the first (Postgres reports the tuple lock's
        // holder, not this transaction), so count the whole wait chain.
        const pid = await backendPid(holder);
        await waitForBlockedBy(holder, pid, { settled: first });
        const deadline = Date.now() + 8000;
        let waiting = 0;
        while (waiting < 2 && Date.now() < deadline && !second.settled()) {
          await holder.$executeRaw`SELECT pg_stat_clear_snapshot()`;
          const [{ n }] = await holder.$queryRaw<{ n: number }[]>`
            WITH RECURSIVE chain(pid) AS (
              SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
              UNION
              SELECT a.pid FROM pg_stat_activity a, chain c WHERE c.pid = ANY(pg_blocking_pids(a.pid))
            )
            SELECT count(*)::int AS n FROM chain`;
          waiting = n;
          if (waiting < 2) await pause(25);
        }
        expect(waiting).toBe(2);
        expect(first.settled() || second.settled()).toBe(false);
      },
      { timeout: 10_000 }
    );

    const outcomes = await Promise.allSettled([first?.promise, second?.promise]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(JerseyNumberTakenError);
    expect(await wearers(org, 23)).toBe(1);
  });
});

describe('sending an invitation with a number (POST /teams/:teamId/invitations)', () => {
  it('refuses an explicit number another member wears', async () => {
    const org = await team('invite-taken');
    const holderId = await wearer('invite-holder', org, 14);
    const inviteeId = await fx.user('invitee', 'PLAYER');

    const err = await InvitationService.createInvitation(
      org.teamId,
      { playerId: inviteeId, jerseyNumber: 14, expiresInDays: 7 },
      coachId
    ).catch((e: unknown) => e);

    expectTaken(err, 14, holderId, 'invite-holder');
    expect(await prisma.teamInvitation.count({ where: { teamId: org.teamId } })).toBe(0);
  });
});

describe('Edit jersey & position (PATCH /teams/:id/players/:playerId)', () => {
  it('refuses a number another member wears and keeps the old one', async () => {
    const org = await team('edit-taken');
    const holderId = await wearer('edit-holder', org, 8);
    const editedId = await wearer('edit-target', org, 5);

    const err = await TeamService.updateTeamMember(org.teamId, editedId, { jerseyNumber: 8 }, coachId).catch(
      (e: unknown) => e
    );

    expectTaken(err, 8, holderId, 'edit-holder');
    expect(await numberOf(org, editedId)).toBe(5);
  });

  it('keeping one\'s own number is a no-op, not an error (0 included)', async () => {
    const org = await team('edit-own');
    const editedId = await wearer('edit-own-target', org, 0);

    const updated = await TeamService.updateTeamMember(
      org.teamId,
      editedId,
      { jerseyNumber: 0, position: 'Center' },
      coachId
    );

    expect(updated.jerseyNumber).toBe(0);
    expect(updated.position).toBe('Center');
  });

  it('clearing the number is always allowed, and frees it for someone else', async () => {
    const org = await team('edit-clear');
    const firstId = await wearer('clear-first', org, 3);
    const secondId = await wearer('clear-second', org, 4);

    await TeamService.updateTeamMember(org.teamId, firstId, { jerseyNumber: null }, coachId);
    const moved = await TeamService.updateTeamMember(org.teamId, secondId, { jerseyNumber: 3 }, coachId);

    expect(await numberOf(org, firstId)).toBeNull();
    expect(moved.jerseyNumber).toBe(3);
  });
});

describe('accepting an invitation whose number was taken meanwhile', () => {
  it('by id: joins with no number, never fails', async () => {
    const org = await team('accept-id');
    const sent = await invitation(org, 'accept-id-invitee', 8);
    await wearer('accept-id-holder', org, 8);

    const result = await InvitationService.acceptInvitation(sent.id, sent.playerId);

    expect(result.invitation.status).toBe('ACCEPTED');
    expect(result.teamMember.jerseyNumber).toBeNull();
    expect(result.teamMember.position).toBe('Guard');
    expect(await wearers(org, 8)).toBe(1);
  });

  it('by token: joins with no number, never fails', async () => {
    const org = await team('accept-token');
    const sent = await invitation(org, 'accept-token-invitee', 0);
    await wearer('accept-token-holder', org, 0);

    const result = await InvitationService.acceptInvitationByToken(sent.token);

    expect(result.invitation.status).toBe('ACCEPTED');
    expect(result.teamMember.jerseyNumber).toBeNull();
    expect(await wearers(org, 0)).toBe(1);
  });

  it('keeps the invitation\'s number when it is still free', async () => {
    const org = await team('accept-free');
    const sent = await invitation(org, 'accept-free-invitee', 11);

    const result = await InvitationService.acceptInvitation(sent.id, sent.playerId);

    expect(result.teamMember.jerseyNumber).toBe(11);
  });
});
