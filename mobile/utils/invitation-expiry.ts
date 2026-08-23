/**
 * Human copy for an invitation's expiry, derived from a timestamp compare.
 *
 * The previous implementation rounded a day-delta with Math.ceil, which
 * yields -0 for anything expired within the last 24h and rendered "Expires
 * today" for an invitation that was already dead (audit #59).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function formatInvitationExpiry(expiresAt: string | Date, now: Date = new Date()): string {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();

  if (Number.isNaN(remainingMs) || remainingMs <= 0) {
    return 'Expired';
  }
  if (remainingMs < DAY_MS) {
    return 'Expires today';
  }
  if (remainingMs < 2 * DAY_MS) {
    return 'Expires tomorrow';
  }
  return `Expires in ${Math.ceil(remainingMs / DAY_MS)} days`;
}

export function isInvitationExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  const t = new Date(expiresAt).getTime();
  return Number.isNaN(t) || t <= now.getTime();
}
