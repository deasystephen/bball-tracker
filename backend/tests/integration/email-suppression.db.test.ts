/**
 * SES bounce/complaint state against a REAL Postgres (#449).
 *
 * The mocked suite (tests/services/ses-events.test.ts) pins which write each
 * event issues. This one proves what those writes DO, which a mock cannot:
 * that the case-insensitive match finds a mixed-case stored address, that the
 * `lt` guard really orders a delivery against the recorded bounce, that a
 * tombstone and an unrelated account are never touched, and that the write
 * paths which change or remove `email` take the delivery state with them.
 *
 * CI provides Postgres and runs `prisma migrate deploy`; locally it uses
 * whatever DATABASE_URL points at (docker-compose). Every row is namespaced by
 * a per-run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomUUID } from 'node:crypto';
import { removeTestRows } from '../support/test-leftovers';
import prisma from '../../src/models';
import { handleSesEventMessage } from '../../src/services/mailer/ses-events';
import { AccountService } from '../../src/services/account-service';
import { PlayerService } from '../../src/services/player-service';
import { WorkOSService } from '../../src/services/workos-service';
import { logger } from '../../src/utils/logger';

jest.setTimeout(30000);

const RUN = randomUUID().slice(0, 8);
const userIds: string[] = [];

const T_BOUNCE = '2026-09-27T18:00:00.000Z';
const T_BEFORE = '2026-09-27T17:00:00.000Z';
const T_AFTER = '2026-09-27T19:00:00.000Z';

function address(key: string): string {
  return `${key}.${RUN}@example.test`;
}

async function mkUser(key: string, data: Record<string, unknown> = {}): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${key}-${RUN}`, email: address(key), role: 'PLAYER', ...data },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

async function state(id: string): Promise<{ email: string | null; at: string | null; reason: string | null }> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: { email: true, emailSuppressedAt: true, emailSuppressedReason: true },
  });
  return {
    email: row.email,
    at: row.emailSuppressedAt?.toISOString() ?? null,
    reason: row.emailSuppressedReason,
  };
}

const mail = { messageId: `ses-${RUN}` };

function bounce(emailAddress: string, timestamp = T_BOUNCE, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: 'Bounce',
    mail,
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress }],
      timestamp,
      ...extra,
    },
  });
}

function complaint(emailAddress: string, timestamp = T_BOUNCE): string {
  return JSON.stringify({
    eventType: 'Complaint',
    mail,
    complaint: { complainedRecipients: [{ emailAddress }], timestamp },
  });
}

function delivery(recipient: string, timestamp: string): string {
  return JSON.stringify({ eventType: 'Delivery', mail, delivery: { recipients: [recipient], timestamp } });
}

describe('email suppression against Postgres (#449)', () => {
  beforeAll(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    // By run id, not only by collected ids: a test that throws before it
    // records a row still cleans up (#584). The ids stay for an account
    // that was deleted during the test and lost its address.
    await removeTestRows(prisma, { run: RUN, alsoUserIds: userIds });
    await prisma.$disconnect();
    jest.restoreAllMocks();
  });

  it('flags the account holding the address, whatever case either side uses', async () => {
    // Accounts created before the lowercase rule can hold a mixed-case address.
    const id = await mkUser('mixed', { email: `Mixed.${RUN}@Example.Test` });
    const bystander = await mkUser('bystander');

    const outcome = await handleSesEventMessage(bounce(`MIXED.${RUN}@example.test`));

    expect(outcome).toEqual({ kind: 'suppressed', reason: 'BOUNCE', recipients: 1, matched: 1 });
    expect(await state(id)).toEqual({
      email: `Mixed.${RUN}@Example.Test`,
      at: T_BOUNCE,
      reason: 'BOUNCE',
    });
    expect(await state(bystander)).toMatchObject({ at: null, reason: null });
  });

  it('does not treat LIKE wildcards in an address as a pattern', async () => {
    // `mode: insensitive` compiles to ILIKE; `_` and `%` must match literally.
    const literal = await mkUser('under_score');
    const lookalike = await mkUser('underXscore');

    await handleSesEventMessage(bounce(address('under_score')));

    expect(await state(literal)).toMatchObject({ reason: 'BOUNCE' });
    expect(await state(lookalike)).toMatchObject({ at: null, reason: null });
  });

  it('matches nothing, and fails nothing, when no account holds the address', async () => {
    await expect(handleSesEventMessage(bounce(address('nobody')))).resolves.toEqual({
      kind: 'suppressed',
      reason: 'BOUNCE',
      recipients: 1,
      matched: 0,
    });
  });

  it('records a complaint over an earlier bounce', async () => {
    const id = await mkUser('complainer');

    await handleSesEventMessage(bounce(address('complainer'), T_BEFORE));
    await handleSesEventMessage(complaint(address('complainer')));

    expect(await state(id)).toMatchObject({ at: T_BOUNCE, reason: 'COMPLAINT' });
  });

  it('a send to an already-suppressed address fills in a missing flag but never overwrites one', async () => {
    const flagged = await mkUser('flagged');
    const unflagged = await mkUser('unflagged');
    await handleSesEventMessage(complaint(address('flagged'), T_BEFORE));
    const resend = { bounceSubType: 'OnAccountSuppressionList' };

    const kept = await handleSesEventMessage(bounce(address('flagged'), T_AFTER, resend));
    const filled = await handleSesEventMessage(bounce(address('unflagged'), T_AFTER, resend));

    expect(kept).toMatchObject({ matched: 0 });
    expect(await state(flagged)).toMatchObject({ at: T_BEFORE, reason: 'COMPLAINT' });
    expect(filled).toMatchObject({ matched: 1 });
    expect(await state(unflagged)).toMatchObject({ at: T_AFTER, reason: 'BOUNCE' });
  });

  it('a transient bounce records nothing', async () => {
    const id = await mkUser('fullmailbox');

    await handleSesEventMessage(
      bounce(address('fullmailbox'), T_BOUNCE, { bounceType: 'Transient', bounceSubType: 'MailboxFull' })
    );

    expect(await state(id)).toMatchObject({ at: null, reason: null });
  });

  describe('delivery', () => {
    it('clears a flag recorded before it', async () => {
      const id = await mkUser('recovered');
      await handleSesEventMessage(bounce(address('recovered')));

      const outcome = await handleSesEventMessage(delivery(address('recovered').toUpperCase(), T_AFTER));

      expect(outcome).toEqual({ kind: 'cleared', recipients: 1, matched: 1 });
      expect(await state(id)).toMatchObject({ at: null, reason: null });
    });

    it.each([
      ['older than', T_BEFORE],
      ['at the same instant as', T_BOUNCE],
    ])('leaves the flag when the delivery is %s the bounce (events arrive out of order)', async (_label, deliveredAt) => {
      const key = `stale${deliveredAt === T_BEFORE ? 'a' : 'b'}`;
      const id = await mkUser(key);
      await handleSesEventMessage(bounce(address(key)));

      const outcome = await handleSesEventMessage(delivery(address(key), deliveredAt));

      expect(outcome).toMatchObject({ matched: 0 });
      expect(await state(id)).toMatchObject({ at: T_BOUNCE, reason: 'BOUNCE' });
    });

    it('is a no-op for an address that was never flagged', async () => {
      const id = await mkUser('healthy');

      await expect(handleSesEventMessage(delivery(address('healthy'), T_AFTER))).resolves.toMatchObject({
        matched: 0,
      });
      expect(await state(id)).toMatchObject({ at: null, reason: null });
    });
  });

  describe('writes that change or remove the address take the state with them', () => {
    it('PlayerService.updatePlayer: a corrected address starts clean', async () => {
      const admin = await mkUser('admin', { role: 'ADMIN' });
      const id = await mkUser('typo');
      await handleSesEventMessage(bounce(address('typo')));
      expect(await state(id)).toMatchObject({ reason: 'BOUNCE' });

      await PlayerService.updatePlayer(id, { email: address('fixed') }, admin);

      expect(await state(id)).toEqual({ email: address('fixed'), at: null, reason: null });
    });

    it('PlayerService.updatePlayer: an edit that leaves the address alone keeps the state', async () => {
      const admin = await mkUser('admin2', { role: 'ADMIN' });
      const id = await mkUser('renamed');
      await handleSesEventMessage(bounce(address('renamed')));

      await PlayerService.updatePlayer(id, { name: `renamed-again-${RUN}` }, admin);

      expect(await state(id)).toMatchObject({ at: T_BOUNCE, reason: 'BOUNCE' });
    });

    it('WorkOSService.syncUser: an email change made in WorkOS starts clean', async () => {
      const workosUserId = `workos_${RUN}`;
      const id = await mkUser('login', { workosUserId });
      await handleSesEventMessage(complaint(address('login')));

      await WorkOSService.syncUser({ id: workosUserId, email: address('login-new'), emailVerified: true });

      expect(await state(id)).toEqual({ email: address('login-new'), at: null, reason: null });
    });

    it('AccountService.deleteAccount: the tombstone carries no delivery state, and no later event reaches it', async () => {
      const id = await mkUser('leaver');
      // A row that survives the purge, so the account is tombstoned rather than
      // erased outright (#529) — this test is about what the tombstone carries.
      await prisma.refreshToken.create({
        data: { userId: id, token: `rt-leaver-${RUN}`, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await handleSesEventMessage(bounce(address('leaver')));

      await AccountService.deleteAccount(id, { actorId: id, mode: 'self' });

      expect(await state(id)).toEqual({ email: null, at: null, reason: null });
      await expect(handleSesEventMessage(bounce(address('leaver'), T_AFTER))).resolves.toMatchObject({
        matched: 0,
      });
      expect(await state(id)).toEqual({ email: null, at: null, reason: null });
    });
  });
});
