import { SesMailer } from './ses-mailer';
import { SUPPORT_EMAIL } from './templates/brand';

export interface EmailTemplate {
  name: string;
  subject(vars: Record<string, string>): string;
  html(vars: Record<string, string>): string;
  text(vars: Record<string, string>): string;
}

export interface MailMetadata {
  userId?: string;
  event_type: string;
  [key: string]: unknown;
}

export interface MailSendParams {
  template: EmailTemplate;
  to: string;
  variables: Record<string, string>;
  metadata: MailMetadata;
  /**
   * The person the message comes from (the inviting coach, an announcement's
   * author): shown as "<name> via Hooplings" in the `From` display name.
   * Omitted, or not usable as a name, the display name is the product name
   * (`sender.ts#formatFromAddress`).
   */
  senderName?: string;
}

export interface MailSendResult {
  messageId: string;
}

export interface Mailer {
  send(params: MailSendParams): Promise<MailSendResult>;
}

export class FakeMailer implements Mailer {
  readonly sentEmails: MailSendParams[] = [];

  async send(params: MailSendParams): Promise<MailSendResult> {
    this.sentEmails.push(params);
    return { messageId: `fake-${Date.now()}` };
  }
}

export function createMailer(): Mailer {
  const region = process.env.AWS_SES_REGION;
  const fromAddress = process.env.SES_FROM_ADDRESS;

  if (!region || !fromAddress) {
    return new FakeMailer();
  }

  const configurationSetName = process.env.SES_CONFIGURATION_SET?.trim() || undefined;

  return new SesMailer({ region, fromAddress, configurationSetName, replyToAddress: SUPPORT_EMAIL });
}

export const mailer: Mailer = createMailer();
