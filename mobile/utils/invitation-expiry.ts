/**
 * Human copy for an invitation's expiry, derived from a timestamp compare.
 *
 * The previous implementation rounded a day-delta with Math.ceil, which
 * yields -0 for anything expired within the last 24h and rendered "Expires
 * today" for an invitation that was already dead (audit #59).
 */

import { i18n } from '../i18n';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function formatInvitationExpiry(expiresAt: string | Date, now: Date = new Date()): string {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();

  if (Number.isNaN(remainingMs) || remainingMs <= 0) {
    return i18n.t('invitations.expired');
  }
  if (remainingMs < DAY_MS) {
    return i18n.t('invitations.expiresToday');
  }
  if (remainingMs < 2 * DAY_MS) {
    return i18n.t('invitations.expiresTomorrow');
  }
  return i18n.t('invitations.expiresInDays', { count: Math.ceil(remainingMs / DAY_MS) });
}

export function isInvitationExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  const t = new Date(expiresAt).getTime();
  return Number.isNaN(t) || t <= now.getTime();
}
