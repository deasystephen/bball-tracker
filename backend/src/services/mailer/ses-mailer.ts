import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Mailer, MailSendParams, MailSendResult } from './index';
import { logger } from '../../utils/logger';

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
      to,
      messageId,
      ...metadata,
    });

    return { messageId };
  }
}
