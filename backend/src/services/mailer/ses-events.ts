/**
 * SES sending events → per-address delivery state on `User` (#449).
 *
 * The SES configuration set publishes Bounce / Complaint / Delivery / Reject
 * events to SNS, which fans them into the SQS queue `ses-event-consumer.ts`
 * polls. This module turns one message body into at most one write:
 *
 *   | Event                          | Effect                                   |
 *   | ------------------------------ | ---------------------------------------- |
 *   | Bounce, `Permanent`            | flag the address, reason BOUNCE          |
 *   | Bounce, `OnAccountSuppression…`| flag only if not flagged (keeps reason)  |
 *   | Bounce, transient/undetermined | log only — SES retries or gives up       |
 *   | Complaint                      | flag the address, reason COMPLAINT       |
 *   | Delivery                       | clear a flag older than the delivery     |
 *   | Reject                         | log only — SES refused the content       |
 *   | anything else                  | ignored                                  |
 *
 * SES's account-level suppression list is what stops delivery to a flagged
 * address; nothing here blocks a send. That is deliberate: state follows SES,
 * so once an operator removes an address from the suppression list the next
 * successful delivery clears the flag with no second step
 * (docs/runbooks/email-deliverability.md).
 *
 * Addresses are matched case-insensitively and never logged — log lines carry
 * `hashRecipient()` like the mailer (audit #48).
 */

import { EmailSuppressionReason } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../models';
import { EMAIL_SUPPRESSION_CLEARED } from '../../utils/email-suppression';
import { logger } from '../../utils/logger';
import { hashRecipient } from './ses-mailer';

/** SES reports a send to an already-suppressed address as this bounce subtype. */
const ON_SUPPRESSION_LIST = 'OnAccountSuppressionList';

const mailSchema = z.object({ messageId: z.string().min(1) });
const recipientSchema = z.object({ emailAddress: z.string().min(1) });

const bounceEventSchema = z.object({
  eventType: z.literal('Bounce'),
  mail: mailSchema,
  bounce: z.object({
    bounceType: z.string(),
    bounceSubType: z.string().optional(),
    bouncedRecipients: z.array(recipientSchema),
    timestamp: z.coerce.date(),
  }),
});

const complaintEventSchema = z.object({
  eventType: z.literal('Complaint'),
  mail: mailSchema,
  complaint: z.object({
    complainedRecipients: z.array(recipientSchema),
    timestamp: z.coerce.date(),
  }),
});

const deliveryEventSchema = z.object({
  eventType: z.literal('Delivery'),
  mail: mailSchema,
  delivery: z.object({
    recipients: z.array(z.string().min(1)),
    timestamp: z.coerce.date(),
  }),
});

const rejectEventSchema = z.object({
  eventType: z.literal('Reject'),
  mail: mailSchema,
  reject: z.object({ reason: z.string() }),
});

const handledEventSchema = z.discriminatedUnion('eventType', [
  bounceEventSchema,
  complaintEventSchema,
  deliveryEventSchema,
  rejectEventSchema,
]);

export type SesEvent = z.infer<typeof handledEventSchema>;

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set(['Bounce', 'Complaint', 'Delivery', 'Reject']);

/** A message body that is not a well-formed SES event. Never deleted: it redrives to the DLQ. */
export class SesEventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesEventParseError';
  }
}

export type SesEventOutcome =
  | { kind: 'suppressed'; reason: EmailSuppressionReason; recipients: number; matched: number }
  | { kind: 'cleared'; recipients: number; matched: number }
  | { kind: 'logged' }
  | { kind: 'ignored' };

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new SesEventParseError(`${what} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse one queue message body. Returns `null` for a well-formed SES event of
 * a type this service does not act on (Send, Open, DeliveryDelay, …).
 *
 * The subscription uses raw message delivery, so the body is the SES event
 * itself; an SNS envelope is unwrapped anyway so flipping that setting cannot
 * silently turn every event into a parse failure.
 */
export function parseSesEvent(body: string): SesEvent | null {
  let payload = parseJson(body, 'Message body');
  if (isRecord(payload) && payload.Type === 'Notification' && typeof payload.Message === 'string') {
    payload = parseJson(payload.Message, 'SNS Message');
  }

  if (!isRecord(payload) || typeof payload.eventType !== 'string') {
    throw new SesEventParseError('Message has no eventType');
  }
  if (!HANDLED_EVENT_TYPES.has(payload.eventType)) {
    return null;
  }

  const parsed = handledEventSchema.safeParse(payload);
  if (!parsed.success) {
    // Issue paths only: the messages can quote the offending value, which may
    // be a recipient address.
    const paths = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new SesEventParseError(`Malformed ${payload.eventType} event (${paths})`);
  }
  return parsed.data;
}

/** `Name <a@b.c>` and `<a@b.c>` both reduce to `a@b.c`. */
function normalizeAddress(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  return (angle ? angle[1] : raw).trim().toLowerCase();
}

function uniqueAddresses(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeAddress).filter((address) => address.length > 0))];
}

/**
 * The `email` values, exactly as stored, of the accounts that hold one of
 * `addresses` (already lower-cased) — compared case-insensitively, since
 * accounts created before the lowercase rule can hold a mixed-case address.
 *
 * Two steps on purpose. Prisma's `mode: 'insensitive'` compiles `equals` to
 * ILIKE without escaping, so `_` and `%` in an address are wildcards: a bounce
 * for `first_last@x.com` would also flag `firstXlast@x.com`. The query is only
 * the candidate search; the exact comparison happens here.
 */
async function storedEmailsFor(addresses: string[]): Promise<string[]> {
  if (addresses.length === 0) return [];

  const candidates = await prisma.user.findMany({
    where: {
      OR: addresses.map((address) => ({ email: { equals: address, mode: 'insensitive' as const } })),
      // The #444 invariant: never write onto a tombstone.
      deletedAt: null,
    },
    select: { email: true },
  });

  const wanted = new Set(addresses);
  return candidates
    .map((candidate) => candidate.email)
    .filter((email): email is string => email !== null && wanted.has(email.toLowerCase()));
}

async function suppress(
  addresses: string[],
  reason: EmailSuppressionReason,
  at: Date,
  onlyIfUnflagged: boolean
): Promise<number> {
  const emails = await storedEmailsFor(addresses);
  if (emails.length === 0) return 0;

  const result = await prisma.user.updateMany({
    where: {
      email: { in: emails },
      deletedAt: null,
      ...(onlyIfUnflagged && { emailSuppressedAt: null }),
    },
    data: { emailSuppressedAt: at, emailSuppressedReason: reason },
  });
  return result.count;
}

async function clear(addresses: string[], deliveredAt: Date): Promise<number> {
  const emails = await storedEmailsFor(addresses);
  if (emails.length === 0) return 0;

  const result = await prisma.user.updateMany({
    where: {
      email: { in: emails },
      deletedAt: null,
      // Only a delivery NEWER than the flag proves the address works again;
      // events are not ordered, and a delivery from before the bounce says
      // nothing about now.
      emailSuppressedAt: { lt: deliveredAt },
    },
    data: EMAIL_SUPPRESSION_CLEARED,
  });
  return result.count;
}

/** Apply one parsed event. Throws only on a database failure (the message is then retried). */
export async function applySesEvent(event: SesEvent): Promise<SesEventOutcome> {
  const messageId = event.mail.messageId;

  switch (event.eventType) {
    case 'Bounce': {
      const { bounceType, bounceSubType, bouncedRecipients, timestamp } = event.bounce;
      const addresses = uniqueAddresses(bouncedRecipients.map((r) => r.emailAddress));
      const context = {
        messageId,
        bounceType,
        bounceSubType,
        toHashes: addresses.map(hashRecipient),
      };

      if (bounceType !== 'Permanent') {
        logger.info('SES transient bounce (not recorded)', context);
        return { kind: 'logged' };
      }

      // A re-send to a suppressed address comes back as a bounce too. It does
      // not know WHY the address is suppressed, so it must not overwrite a
      // recorded COMPLAINT — it only fills in a flag that is missing.
      const onlyIfUnflagged = bounceSubType === ON_SUPPRESSION_LIST;
      const matched = await suppress(addresses, 'BOUNCE', timestamp, onlyIfUnflagged);
      logger.warn('SES permanent bounce recorded', { ...context, matched });
      return { kind: 'suppressed', reason: 'BOUNCE', recipients: addresses.length, matched };
    }

    case 'Complaint': {
      const { complainedRecipients, timestamp } = event.complaint;
      const addresses = uniqueAddresses(complainedRecipients.map((r) => r.emailAddress));
      const matched = await suppress(addresses, 'COMPLAINT', timestamp, false);
      logger.warn('SES complaint recorded', {
        messageId,
        toHashes: addresses.map(hashRecipient),
        matched,
      });
      return { kind: 'suppressed', reason: 'COMPLAINT', recipients: addresses.length, matched };
    }

    case 'Delivery': {
      const addresses = uniqueAddresses(event.delivery.recipients);
      const matched = await clear(addresses, event.delivery.timestamp);
      if (matched > 0) {
        logger.info('SES delivery cleared a recorded bounce/complaint', {
          messageId,
          toHashes: addresses.map(hashRecipient),
          matched,
        });
      }
      return { kind: 'cleared', recipients: addresses.length, matched };
    }

    case 'Reject': {
      logger.warn('SES rejected a message before sending', { messageId, reason: event.reject.reason });
      return { kind: 'logged' };
    }
  }
}

/** Parse and apply one queue message body. */
export async function handleSesEventMessage(body: string): Promise<SesEventOutcome> {
  const event = parseSesEvent(body);
  if (event === null) {
    return { kind: 'ignored' };
  }
  return applySesEvent(event);
}
