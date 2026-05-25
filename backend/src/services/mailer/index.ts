import { SesMailer } from './ses-mailer';

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

  return new SesMailer({ region, fromAddress });
}

export const mailer: Mailer = createMailer();
