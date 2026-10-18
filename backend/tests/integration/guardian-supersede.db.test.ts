/**
 * Guardian Resend (supersede, #420) against a REAL Postgres.
 *
 * The mocked service suite cannot prove the two things that matter here: that
 * the expire and the create commit together, and that a resend which loses a
 * race hits the partial index `GuardianInvitation_pending_childId_invitedEmail_key`
 * under the name `createOrConflict` matches (Prisma 7 reports it at
 * `meta.driverAdapterError.cause.constraint.index`), so the loser answers the
 * dedupe 400 instead of a 500.
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../src/models';
import {
  GuardianService,
  GUARDIAN_INVITATION_RESEND_COOLDOWN_MS,
} from '../../src/services/guardian-service';
import { BadRequestError, ResendCooldownError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { pause } from '../support/db-locks';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'guardian-supersede');
let org: Org;
let coachId: string;

const DAY_MS = 24 * 60 * 60 * 1000;

async function emailOf(userId: string): Promise<string> {
  const { email } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  if (!email) throw new Error('fixture user has no email');
  return email;
}

/** A rostered child, an adult, and one PENDING invitation for the pair created `ageMs` ago. */
async function childWithPending(
  key: string,
  ageMs: number
): Promise<{ childId: string; email: string; liveId: string }> {
  const childId = await fx.user(`${key}-child`, 'PLAYER');
  await fx.member(childId, org);
  const email = await emailOf(await fx.user(`${key}-parent`, 'PLAYER'));
  const live = await prisma.guardianInvitation.create({
    data: {
      token: randomBytes(32).toString('base64url'),
      childId,
      teamId: org.teamId,
      invitedEmail: email,
      relationship: 'MOTHER',
      invitedById: coachId,
      createdAt: new Date(Date.now() - ageMs),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      status: 'PENDING',
    },
    select: { id: true },
  });
  return { childId, email, liveId: live.id };
}

async function rowsFor(childId: string): Promise<{ id: string; status: string }[]> {
  return prisma.guardianInvitation.findMany({
    where: { childId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true },
  });
}

/**
 * Waits until two backends of this database sit in a lock wait on a
 * `GuardianInvitation` statement and returns how many there are (fewer on
 * timeout). The second resend queues behind the first one's tuple lock, so it
 * is not always reported as blocked by the holder itself.
 */
async function lockWaiters(tx: Prisma.TransactionClient, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // pg_stat_activity is snapshotted once per transaction; the holder polls
    // from inside one, so drop the snapshot before every read.
    await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE 'UPDATE "public"."GuardianInvitation"%'`;
    if (n >= 2 || Date.now() > deadline) {
      return n;
    }
    await pause(25);
  }
}

const PAST_COOLDOWN = GUARDIAN_INVITATION_RESEND_COOLDOWN_MS + 60_000;

beforeAll(async () => {
  await fx.requireDatabase();
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  org = await fx.org('team');
  coachId = await fx.user('coach', 'COACH');
  await fx.staff(coachId, org);
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

describe('guardian resend (supersede, #420)', () => {
  it('expires the live invitation and creates the replacement, leaving exactly one PENDING row', async () => {
    const { childId, email, liveId } = await childWithPending('resend', PAST_COOLDOWN);

    const result = await GuardianService.inviteGuardian(
      org.teamId,
      childId,
      { email, relationship: 'MOTHER', supersede: true },
      coachId
    );

    expect(result.emailSent).toBe(true);
    expect(result.id).not.toBe(liveId);
    expect(await rowsFor(childId)).toEqual([
      { id: liveId, status: 'EXPIRED' },
      { id: result.id, status: 'PENDING' },
    ]);
  });

  it('without supersede, a live invitation still answers the dedupe 400', async () => {
    const { childId, email, liveId } = await childWithPending('plain', PAST_COOLDOWN);

    await expect(
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'MOTHER' }, coachId)
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'PENDING' }]);
  });

  it('refuses a resend inside the cooldown and leaves the live row untouched', async () => {
    const { childId, email, liveId } = await childWithPending('cooldown', 30_000);

    await expect(
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'MOTHER', supersede: true }, coachId)
    ).rejects.toBeInstanceOf(ResendCooldownError);
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'PENDING' }]);
  });

  it('two resends racing past the cooldown: one wins, the loser hits the partial index and answers 400', async () => {
    const { childId, email, liveId } = await childWithPending('race', PAST_COOLDOWN);
    const resend = (): Promise<unknown> =>
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'MOTHER', supersede: true }, coachId);

    // Hold the live row so both resends pass their reads (link check,
    // cooldown) and then queue on the expire. When the holder commits, one
    // expires and inserts; the other's expire then matches nothing and its
    // insert collides on the partial PENDING index.
    let calls: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT "id" FROM "GuardianInvitation" WHERE "id" = ${liveId} FOR UPDATE`;
        calls = Promise.allSettled([resend(), resend()]);
        expect(await lockWaiters(holder)).toBe(2);
      },
      { timeout: 10_000 }
    );

    const settled = await calls!;
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestError);
    expect((rejected[0].reason as BadRequestError).message).toBe(
      'A pending guardian invitation already exists for this email'
    );

    const rows = await rowsFor(childId);
    expect(rows.filter((r) => r.status === 'PENDING')).toHaveLength(1);
    expect(rows.find((r) => r.id === liveId)?.status).toBe('EXPIRED');
  });
});
