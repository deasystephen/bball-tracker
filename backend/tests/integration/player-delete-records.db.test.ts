/**
 * What `DELETE /players/:id` may erase (#1047), against a REAL Postgres.
 *
 * The hard delete cascades through every relation on `User`. Before #1047 it
 * refused only a row on a team or with game events; this suite first shows,
 * through the production paths (Add Player, guardian RSVP and practice answer,
 * removal from the roster, the stats finalization), which other rows a record
 * that passes those two checks still carries, and then that the delete now
 * refuses such a row (409 `player_has_records`, every row kept) and erases
 * only one nothing references (the #529 erasure rule of account deletion).
 *
 * Also: the FOR UPDATE on the row, so a row that starts being referenced
 * while the delete waits is refused rather than cascaded.
 *
 * Every row carries the fixture run id and is removed in afterAll.
 */
jest.unmock('../../src/models');
import prisma from '../../src/models';
import { PlayerService } from '../../src/services/player-service';
import { InvitationService } from '../../src/services/invitation-service';
import { TeamService } from '../../src/services/team-service';
import { RsvpService } from '../../src/services/rsvp-service';
import { PracticeService } from '../../src/services/practice-service';
import { GameEventService } from '../../src/services/game-event-service';
import { GameService } from '../../src/services/game-service';
import { USER_REFERENCE_SELECT, referencingRelations } from '../../src/services/account-service';
import { PlayerHasRecordsError } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { backendPid, track, waitForBlockedBy } from '../support/db-locks';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'delrecords');
let org: Org;
let coachId: string;
let adminId: string;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await fx.requireDatabase();
  coachId = await fx.user('coach', 'COACH');
  adminId = await fx.user('admin', 'ADMIN');
  org = await fx.org('team');
  await fx.staff(coachId, org);
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

/** Add Player through the production path; returns the new row's id. */
async function addPlayer(key: string, extra: { playerEmail?: string; guardianEmail?: string } = {}): Promise<string> {
  const result = await InvitationService.addRosterPlayer(
    org.teamId,
    {
      name: `${key}-${fx.run}`,
      ...extra,
      ...(extra.guardianEmail && { guardianRelationship: 'MOTHER' as const }),
    },
    coachId
  );
  const playerId = result.member?.playerId;
  if (!playerId) throw new Error(`Add Player did not roster ${key}`);
  fx.users[key] = playerId;
  return playerId;
}

async function references(userId: string): Promise<string[]> {
  const refs = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: USER_REFERENCE_SELECT });
  return referencingRelations(refs).sort();
}

async function exists(id: string): Promise<boolean> {
  return (await prisma.user.count({ where: { id } })) === 1;
}

describe('rows a removed roster record still carries (the evidence for #1047)', () => {
  it('a managed child who left the team keeps guardian links, the guardian invitation, RSVPs and past practice answers', async () => {
    const parentId = await fx.user('mom', 'PARENT');
    const parentEmail = `mom.${fx.run}@example.test`;
    const kidId = await addPlayer('kid', { guardianEmail: parentEmail });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: kidId } })).isManaged).toBe(true);
    // The accepted link (accept itself is covered by guardian-accept.db.test.ts).
    await fx.guardian(parentId, kidId);

    // The guardian answers for the child: a game RSVP and a practice answer.
    const gameId = await fx.game(org, { date: new Date(Date.now() + 7 * DAY_MS) });
    await RsvpService.upsertRsvp(gameId, parentId, 'YES', kidId);
    const practice = await prisma.practiceSession.create({
      data: { teamId: org.teamId, startsAt: new Date(Date.now() + 2 * DAY_MS), durationMinutes: 60, timezone: 'UTC' },
      select: { id: true },
    });
    await PracticeService.upsertAvailability(practice.id, parentId, { status: 'YES', playerId: kidId });
    // Time passes: the practice is history, which removal from the roster keeps.
    await prisma.practiceSession.update({
      where: { id: practice.id },
      data: { startsAt: new Date(Date.now() - 2 * DAY_MS) },
    });

    await TeamService.removePlayer(org.teamId, kidId, coachId);

    // Passes the old checks: no team, no game events …
    expect(await prisma.teamMember.count({ where: { playerId: kidId } })).toBe(0);
    expect(await prisma.gameEvent.count({ where: { playerId: kidId } })).toBe(0);
    // … and still referenced by four relations the old hard delete cascaded away.
    expect(await references(kidId)).toEqual(
      ['gameRsvps', 'guardianInvitationsAsChild', 'guardiansAsChild', 'practiceAvailability'].sort()
    );

    // Now: refused, and every one of those rows is still there.
    const refusal = await PlayerService.deletePlayer(kidId, adminId).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlayerHasRecordsError);
    expect((refusal as PlayerHasRecordsError).body()).toMatchObject({
      code: 'player_has_records',
      relations: expect.arrayContaining(['guardiansAsChild', 'gameRsvps', 'practiceAvailability']),
    });
    expect(await exists(kidId)).toBe(true);
    expect(await prisma.guardian.count({ where: { childId: kidId } })).toBe(1);
    expect(await prisma.guardianInvitation.count({ where: { childId: kidId } })).toBe(1);
    expect(await prisma.gameRsvp.count({ where: { userId: kidId } })).toBe(1);
    expect(await prisma.practiceAvailability.count({ where: { userId: kidId } })).toBe(1);
  });

  it('a player added by email and removed keeps the team invitation', async () => {
    const preId = await addPlayer('pre', { playerEmail: `pre.${fx.run}@example.test` });
    await TeamService.removePlayer(org.teamId, preId, coachId);

    expect(await references(preId)).toEqual(['receivedInvitations']);
    await expect(PlayerService.deletePlayer(preId, adminId)).rejects.toBeInstanceOf(PlayerHasRecordsError);
    expect(await prisma.teamInvitation.count({ where: { playerId: preId } })).toBe(1);
  });

  it('PlayerStats cannot outlive the events: deleting the last event of a FINISHED game re-finalizes them away', async () => {
    const shooterId = await addPlayer('shooter');
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    const { event } = await GameEventService.createEvent(
      gameId,
      { eventType: 'SHOT', playerId: shooterId, metadata: { made: true, points: 2 } },
      coachId
    );
    await GameService.updateGame(gameId, { status: 'FINISHED' }, coachId);
    expect(await prisma.playerStats.count({ where: { playerId: shooterId } })).toBe(1);

    await GameEventService.deleteEvent(gameId, event.id, coachId);

    expect(await prisma.gameEvent.count({ where: { playerId: shooterId } })).toBe(0);
    expect(await prisma.playerStats.count({ where: { playerId: shooterId } })).toBe(0);
  });
});

describe('PlayerService.deletePlayer erases only a record nothing references (#1047)', () => {
  it('deletes a bare managed record (added, then removed, nothing else)', async () => {
    const bareId = await addPlayer('bare');
    await TeamService.removePlayer(org.teamId, bareId, coachId);
    expect(await references(bareId)).toEqual([]);

    await expect(PlayerService.deletePlayer(bareId, adminId)).resolves.toEqual({ success: true });

    expect(await exists(bareId)).toBe(false);
  });

  it('a reference that commits while the delete waits on the row lock is refused, not cascaded', async () => {
    const racedId = await addPlayer('raced');
    await TeamService.removePlayer(org.teamId, racedId, coachId);
    const gameId = await fx.game(org);

    let call: ReturnType<typeof track<unknown>> | undefined;
    await prisma.$transaction(
      async (holder) => {
        // NO KEY UPDATE: the holder's own RSVP insert below needs only a key-share on the row.
        await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${racedId} FOR NO KEY UPDATE`;
        const pid = await backendPid(holder);
        call = track(PlayerService.deletePlayer(racedId, adminId));
        call.promise.catch(() => undefined);
        await waitForBlockedBy(holder, pid, { tables: ['User'], timeoutMs: 4000, settled: call });
        await holder.gameRsvp.create({ data: { gameId, userId: racedId, status: 'YES' } });
      },
      { timeout: 10_000 }
    );

    await expect(call?.promise).rejects.toBeInstanceOf(PlayerHasRecordsError);
    expect(await exists(racedId)).toBe(true);
    expect(await prisma.gameRsvp.count({ where: { userId: racedId } })).toBe(1);
  });
});
