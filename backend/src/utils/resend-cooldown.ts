/**
 * The per-recipient resend cooldown shared by team invitations (#715) and
 * guardian invitations (#420). An expire-and-recreate whose newest invitation
 * row for the recipient is younger than the window is refused with 429
 * `resend_cooldown` before anything is expired or mailed. Every invitation
 * row is one email, so this caps one address at one message per window.
 *
 * Each service decides which row is "the newest for this recipient" (team:
 * the team/player pair, skipped when the address changed; guardian: the
 * child + address) and passes its `createdAt` here.
 */

import { ResendCooldownError } from './errors';

/** One window for every invitation kind. */
export const INVITATION_RESEND_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Throws `ResendCooldownError` when `latestCreatedAt` is inside `windowMs`.
 * No prior row (`null`/`undefined`) never refuses. `onRefused` runs just
 * before the throw so the caller can log its own ids-only domain event.
 */
export function assertResendCooldown(
  latestCreatedAt: Date | null | undefined,
  windowMs: number,
  recipientWord: 'player' | 'address',
  onRefused?: (retryAfterSeconds: number) => void
): void {
  if (!latestCreatedAt) {
    return;
  }
  const sinceLatestMs = Date.now() - latestCreatedAt.getTime();
  if (sinceLatestMs < windowMs) {
    const retryAfterSeconds = Math.ceil((windowMs - sinceLatestMs) / 1000);
    onRefused?.(retryAfterSeconds);
    throw new ResendCooldownError(retryAfterSeconds, recipientWord);
  }
}
