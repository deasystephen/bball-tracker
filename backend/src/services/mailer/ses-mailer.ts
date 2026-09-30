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

export interface SesMailerOptions {
  region: string;
  fromAddress: string;
  /**
   * SES configuration set every send is attributed to (#449). It is what
   * publishes bounce/complaint/delivery events; a send without it is invisible
   * to `ses-events.ts`. Optional so the mailer still works before the
   * configuration set exists.
   */
  configurationSetName?: string;
  /**
   * `Reply-To` of every message (#450). The sender is a no-reply address on
   * the SES subdomain, so without it a reply goes to the bounce handler.
   */
  replyToAddress?: string;
}

export class SesMailer implements Mailer {
  private client: SESv2Client;
  private fromAddress: string;
  private configurationSetName: string | undefined;
  private replyToAddress: string | undefined;

  constructor({ region, fromAddress, configurationSetName, replyToAddress }: SesMailerOptions) {
    this.client = new SESv2Client({ region });
    this.fromAddress = fromAddress;
    this.configurationSetName = configurationSetName;
    this.replyToAddress = replyToAddress;
  }

  async send(params: MailSendParams): Promise<MailSendResult> {
    const { template, to, variables, metadata } = params;

    const subject = template.subject(variables);
    const html = template.html(variables);
    const text = template.text(variables);

    const command = new SendEmailCommand({
      FromEmailAddress: this.fromAddress,
      ...(this.configurationSetName && { ConfigurationSetName: this.configurationSetName }),
      ...(this.replyToAddress && { ReplyToAddresses: [this.replyToAddress] }),
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
