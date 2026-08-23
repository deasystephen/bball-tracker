import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Mailer, MailSendParams, MailSendResult } from './index';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger';

/**
 * Stable, non-reversible recipient identifier for logs: first 12 hex chars of
 * sha256(lowercased address). Lets ops correlate repeated sends to one
 * recipient without putting the address itself in CloudWatch (audit #48).
 */
export function hashRecipient(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 12);
}

export class SesMailer implements Mailer {
  private client: SESv2Client;
  private fromAddress: string;

  constructor({ region, fromAddress }: { region: string; fromAddress: string }) {
    this.client = new SESv2Client({ region });
    this.fromAddress = fromAddress;
  }

  async send(params: MailSendParams): Promise<MailSendResult> {
    const { template, to, variables, metadata } = params;

    const subject = template.subject(variables);
    const html = template.html(variables);
    const text = template.text(variables);

    const command = new SendEmailCommand({
      FromEmailAddress: this.fromAddress,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    });

    const result = await this.client.send(command);
    const messageId = result.MessageId ?? '';

    logger.info('Email sent via SES', {
      template: template.name,
      toHash: hashRecipient(to),
      messageId,
      ...metadata,
    });
    // Full address only at debug, which `logger` emits solely under
    // NODE_ENV=development — never in production logs.
    logger.debug('Email recipient', { to, messageId });

    return { messageId };
  }
}
