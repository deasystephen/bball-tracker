/**
 * "This address bounced" on a roster row (#449).
 *
 * The backend records what SES reported for a player's address
 * (`emailSuppressedAt` / `emailSuppressedReason`) and returns it on
 * `GET /teams/:id` to roster managers only. Derivation lives here — never
 * inline it in a screen (same convention as utils/roster-status.ts):
 *
 * ```
 * player.deletedAt set ──────────────────────► none (a tombstone has no address)
 * no email on file ──────────────────────────► none (nothing to deliver to)
 * emailSuppressedAt unset ───────────────────► none
 * emailSuppressedReason === 'COMPLAINT' ─────► COMPLAINT (the recipient reported
 *                                                         the mail as spam)
 * otherwise (BOUNCE, or a reason this build
 *            does not know) ─────────────────► BOUNCED  (mail to the address
 *                                                         is not delivered)
 * ```
 *
 * The flag follows the ADDRESS, not the person: changing the player's email
 * clears it server-side, and so does a later successful delivery.
 */

export type EmailDeliveryIssue = 'bounced' | 'complaint';

export interface EmailDeliveryFields {
  email?: string | null;
  deletedAt?: string | null;
  emailSuppressedAt?: string | null;
  emailSuppressedReason?: string | null;
}

export function getEmailDeliveryIssue(player: EmailDeliveryFields): EmailDeliveryIssue | null {
  if (player.deletedAt || !player.email || !player.emailSuppressedAt) {
    return null;
  }
  return player.emailSuppressedReason === 'COMPLAINT' ? 'complaint' : 'bounced';
}

/** Chip text. */
export function emailDeliveryIssueLabel(issue: EmailDeliveryIssue): string {
  switch (issue) {
    case 'bounced':
      return 'Email bounced';
    case 'complaint':
      return 'Email blocked';
  }
}

/** One sentence for the coach: what happened and what to do about it. */
export function emailDeliveryIssueExplanation(issue: EmailDeliveryIssue): string {
  switch (issue) {
    case 'bounced':
      return 'Mail to this address bounced, so invitations are not reaching it. Check it for typos.';
    case 'complaint':
      return 'The owner of this address reported our mail as spam, so nothing more is delivered to it. Check that it belongs to this player.';
  }
}
