/**
 * SES sending events → `User.emailSuppressedAt` / `emailSuppressedReason` (#449).
 *
 * Prisma is mocked here, so these tests pin WHICH write each event produces.
 * That the `mode: 'insensitive'` match and the `lt` guard behave as intended
 * against Postgres is covered in tests/integration/email-suppression.db.test.ts.
 */

import {
  applySesEvent,
  handleSesEventMessage,
  parseSesEvent,
  SesEventParseError,
} from '../../src/services/mailer/ses-events';
import { hashRecipient } from '../../src/services/mailer/ses-mailer';
import { logger } from '../../src/utils/logger';
import { mockPrisma } from '../setup';

const BOUNCED_AT = '2026-09-27T18:00:00.000Z';
const mail = { messageId: 'ses-message-1', destination: ['kid@example.com'] };

function bounce(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'Bounce',
    mail,
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: 'kid@example.com', status: '5.1.1' }],
      timestamp: BOUNCED_AT,
      ...overrides,
    },
  };
}

function complaint(recipients: string[] = ['kid@example.com']): Record<string, unknown> {
  return {
    eventType: 'Complaint',
    mail,
    complaint: {
      complainedRecipients: recipients.map((emailAddress) => ({ emailAddress })),
      timestamp: BOUNCED_AT,
      complaintFeedbackType: 'abuse',
    },
  };
}

function delivery(recipients: string[] = ['kid@example.com']): Record<string, unknown> {
  return {
    eventType: 'Delivery',
    mail,
    delivery: { recipients, timestamp: BOUNCED_AT, smtpResponse: '250 ok' },
  };
}

const updateMany = mockPrisma.user.updateMany as jest.Mock;

describe('parseSesEvent', () => {
  it('parses a raw SES event body', () => {
    const event = parseSesEvent(JSON.stringify(bounce()));
    expect(event).toMatchObject({ eventType: 'Bounce', mail: { messageId: 'ses-message-1' } });
    expect(event?.eventType === 'Bounce' && event.bounce.timestamp).toEqual(new Date(BOUNCED_AT));
  });

  it('unwraps an SNS envelope, so turning raw delivery off cannot break parsing', () => {
    const envelope = { Type: 'Notification', MessageId: 'sns-1', Message: JSON.stringify(complaint()) };
    expect(parseSesEvent(JSON.stringify(envelope))).toMatchObject({ eventType: 'Complaint' });
  });

  it.each(['Send', 'Open', 'Click', 'DeliveryDelay', 'RenderingFailure', 'Subscription'])(
    'returns null for the %s event, which this service does not act on',
    (eventType) => {
      expect(parseSesEvent(JSON.stringify({ eventType, mail }))).toBeNull();
    }
  );

  it.each([
    ['not JSON', 'not json at all', 'Message body is not valid JSON'],
    ['an empty body', '', 'Message body is not valid JSON'],
    ['an SNS envelope around non-JSON', JSON.stringify({ Type: 'Notification', Message: '<xml/>' }), 'SNS Message is not valid JSON'],
    ['a JSON array', '[]', 'Message has no eventType'],
    ['JSON null', 'null', 'Message has no eventType'],
    ['no eventType', JSON.stringify({ mail }), 'Message has no eventType'],
    ['a non-string eventType', JSON.stringify({ eventType: 7, mail }), 'Message has no eventType'],
  ])('rejects %s', (_label, body, message) => {
    expect(() => parseSesEvent(body)).toThrow(new SesEventParseError(message));
  });

  it('rejects a handled event with a missing section, naming paths and never values', () => {
    const body = JSON.stringify({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: '' }], timestamp: 'never' },
    });

    let thrown: unknown;
    try {
      parseSesEvent(body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SesEventParseError);
    const message = (thrown as Error).message;
    expect(message).toContain('Malformed Bounce event');
    expect(message).toContain('bounce.bouncedRecipients.0.emailAddress');
    expect(message).toContain('bounce.timestamp');
    expect(message).not.toContain('never');
  });

  it('rejects an event with no mail.messageId', () => {
    expect(() => parseSesEvent(JSON.stringify({ ...delivery(), mail: {} }))).toThrow(
      /Malformed Delivery event \(mail\.messageId\)/
    );
  });
});

describe('applySesEvent', () => {
  const findMany = mockPrisma.user.findMany as jest.Mock;
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  /** The accounts the candidate search returns, by stored `email`. */
  function setHolders(...emails: Array<string | null>): void {
    findMany.mockResolvedValue(emails.map((email) => ({ email })));
  }

  beforeEach(() => {
    setHolders('kid@example.com');
    updateMany.mockResolvedValue({ count: 1 });
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  function apply(payload: Record<string, unknown>): ReturnType<typeof handleSesEventMessage> {
    return handleSesEventMessage(JSON.stringify(payload));
  }

  describe('finding the account that holds the address', () => {
    it('searches case-insensitively, never among tombstones, and writes by the stored value', async () => {
      // An account created before the lowercase rule.
      setHolders('Kid@Example.com');

      await apply(bounce({ bouncedRecipients: [{ emailAddress: 'KID@example.com' }] }));

      expect(findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ email: { equals: 'kid@example.com', mode: 'insensitive' } }],
          deletedAt: null,
        },
        select: { email: true },
      });
      expect(updateMany.mock.calls[0][0].where).toEqual({
        email: { in: ['Kid@Example.com'] },
        deletedAt: null,
      });
    });

    it('drops a candidate that only matched because "_" is an ILIKE wildcard', async () => {
      // The insensitive filter is ILIKE: `first_last` also finds `firstXlast`.
      setHolders('firstXlast@example.com', 'First_Last@example.com', null);

      await apply(bounce({ bouncedRecipients: [{ emailAddress: 'first_last@example.com' }] }));

      expect(updateMany.mock.calls[0][0].where.email).toEqual({ in: ['First_Last@example.com'] });
    });

    it('writes nothing when no account holds the address any more', async () => {
      setHolders();

      await expect(apply(bounce())).resolves.toEqual({
        kind: 'suppressed',
        reason: 'BOUNCE',
        recipients: 1,
        matched: 0,
      });
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('searches once per distinct address and reads "Name <address>" forms', async () => {
      setHolders('kid@example.com', 'mom@example.com');
      updateMany.mockResolvedValue({ count: 2 });

      const outcome = await apply(
        bounce({
          bouncedRecipients: [
            { emailAddress: 'Kid Example <kid@example.com>' },
            { emailAddress: ' KID@example.com ' },
            { emailAddress: '<mom@example.com>' },
            { emailAddress: '   ' },
          ],
        })
      );

      expect(findMany.mock.calls[0][0].where.OR).toEqual([
        { email: { equals: 'kid@example.com', mode: 'insensitive' } },
        { email: { equals: 'mom@example.com', mode: 'insensitive' } },
      ]);
      expect(outcome).toEqual({ kind: 'suppressed', reason: 'BOUNCE', recipients: 2, matched: 2 });
    });

    it('does not query at all for an event that names no usable address', async () => {
      await expect(apply(bounce({ bouncedRecipients: [{ emailAddress: '  ' }] }))).resolves.toMatchObject({
        recipients: 0,
        matched: 0,
      });

      expect(findMany).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('permanent bounce', () => {
    it('flags the address with reason BOUNCE', async () => {
      const outcome = await apply(bounce());

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { email: { in: ['kid@example.com'] }, deletedAt: null },
        data: { emailSuppressedAt: new Date(BOUNCED_AT), emailSuppressedReason: 'BOUNCE' },
      });
      expect(outcome).toEqual({ kind: 'suppressed', reason: 'BOUNCE', recipients: 1, matched: 1 });
    });

    it('only fills in a missing flag for a send to an already-suppressed address', async () => {
      // The re-send does not know WHY the address is suppressed; overwriting
      // would turn a recorded COMPLAINT into a BOUNCE.
      await apply(bounce({ bounceSubType: 'OnAccountSuppressionList' }));

      expect(updateMany).toHaveBeenCalledWith({
        where: { email: { in: ['kid@example.com'] }, deletedAt: null, emailSuppressedAt: null },
        data: { emailSuppressedAt: new Date(BOUNCED_AT), emailSuppressedReason: 'BOUNCE' },
      });
    });

    it('treats a bounce with no subtype as a plain permanent bounce', async () => {
      await apply(bounce({ bounceSubType: undefined }));
      expect(updateMany.mock.calls[0][0].where).not.toHaveProperty('emailSuppressedAt');
    });
  });

  it.each(['Transient', 'Undetermined'])('logs a %s bounce and writes nothing', async (bounceType) => {
    await expect(apply(bounce({ bounceType, bounceSubType: 'MailboxFull' }))).resolves.toEqual({
      kind: 'logged',
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('flags a complaint with reason COMPLAINT, overwriting an earlier bounce', async () => {
    setHolders('kid@example.com', 'mom@example.com');
    updateMany.mockResolvedValue({ count: 2 });

    const outcome = await apply(complaint(['Kid@example.com', 'mom@example.com']));

    expect(updateMany).toHaveBeenCalledWith({
      where: { email: { in: ['kid@example.com', 'mom@example.com'] }, deletedAt: null },
      data: { emailSuppressedAt: new Date(BOUNCED_AT), emailSuppressedReason: 'COMPLAINT' },
    });
    expect(outcome).toEqual({ kind: 'suppressed', reason: 'COMPLAINT', recipients: 2, matched: 2 });
  });

  describe('delivery', () => {
    it('clears a flag that is OLDER than the delivery, and only that', async () => {
      const outcome = await apply(delivery(['Kid@example.com']));

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          email: { in: ['kid@example.com'] },
          deletedAt: null,
          emailSuppressedAt: { lt: new Date(BOUNCED_AT) },
        },
        data: { emailSuppressedAt: null, emailSuppressedReason: null },
      });
      expect(outcome).toEqual({ kind: 'cleared', recipients: 1, matched: 1 });
      expect(infoSpy).toHaveBeenCalledWith(
        'SES delivery cleared a recorded bounce/complaint',
        expect.objectContaining({ matched: 1 })
      );
    });

    it('stays quiet for the ordinary case: a delivery to an address that was never flagged', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(apply(delivery())).resolves.toEqual({ kind: 'cleared', recipients: 1, matched: 0 });
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('writes nothing when no account holds the address', async () => {
      setHolders();

      await expect(apply(delivery())).resolves.toEqual({ kind: 'cleared', recipients: 1, matched: 0 });
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  it('logs a reject and writes nothing', async () => {
    const outcome = await apply({ eventType: 'Reject', mail, reject: { reason: 'Bad content' } });

    expect(outcome).toEqual({ kind: 'logged' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('SES rejected a message before sending', {
      messageId: 'ses-message-1',
      reason: 'Bad content',
    });
  });

  it('ignores an event type it does not act on', async () => {
    await expect(apply({ eventType: 'Open', mail })).resolves.toEqual({ kind: 'ignored' });
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['the search', (): unknown => findMany.mockRejectedValue(new Error('connection refused'))],
    ['the write', (): unknown => updateMany.mockRejectedValue(new Error('connection refused'))],
  ])('lets a database failure in %s propagate, so the queue redelivers the event', async (_label, arm) => {
    arm();
    await expect(apply(bounce())).rejects.toThrow('connection refused');
  });

  // Audit #48: recipient addresses never reach the logs.
  it('logs hashed recipients, never an address', async () => {
    await apply(bounce());
    await apply(bounce({ bounceType: 'Transient' }));
    await apply(complaint());
    await apply(delivery());

    const logged = JSON.stringify([...warnSpy.mock.calls, ...infoSpy.mock.calls]);
    expect(logged).not.toContain('kid@example.com');
    expect(logged).toContain(hashRecipient('kid@example.com'));
  });

  it('applies an already-parsed event', async () => {
    const event = parseSesEvent(JSON.stringify(complaint()));
    if (event === null) throw new Error('expected a handled event');

    await expect(applySesEvent(event)).resolves.toMatchObject({ kind: 'suppressed', reason: 'COMPLAINT' });
  });
});
