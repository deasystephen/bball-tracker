import { createHash } from 'crypto';

/**
 * Stable, non-reversible recipient identifier for logs and for the resend
 * cooldown (#715): first 12 hex chars of sha256(lowercased, trimmed address).
 * Lets ops correlate repeated sends to one recipient without putting the
 * address itself in CloudWatch (audit #48). Pure: no SES or logger import, so
 * the seed and the services can use it without loading the mailer.
 */
export function hashRecipient(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 12);
}
