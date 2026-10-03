/**
 * "Just now" / "3h ago" / "Yesterday" / "Oct 3" for timeline rows
 * (announcements and their replies). One definition so the list and the
 * thread agree; strings come from `common.*` in the locale files.
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const HOUR_MS = 60 * 60 * 1000;

export function formatRelativeTime(iso: string, t: Translate, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffHours = Math.floor((now.getTime() - date.getTime()) / HOUR_MS);

  if (diffHours < 1) return t('common.justNow');
  if (diffHours < 24) return t('common.hoursAgo', { count: diffHours });
  if (diffHours < 48) return t('common.yesterday');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
