import { formatRelativeTime } from '../../utils/relative-time';
import { i18n } from '../../i18n';

const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);
const NOW = new Date('2026-10-03T12:00:00Z');

describe('formatRelativeTime', () => {
  it('says "Just now" inside the first hour', () => {
    expect(formatRelativeTime('2026-10-03T11:30:00Z', t, NOW)).toBe('Just now');
  });

  it('counts hours inside the first day', () => {
    expect(formatRelativeTime('2026-10-03T08:15:00Z', t, NOW)).toBe('3h ago');
  });

  it('says "Yesterday" between 24 and 48 hours', () => {
    expect(formatRelativeTime('2026-10-02T06:00:00Z', t, NOW)).toBe('Yesterday');
  });

  it('falls back to a short date beyond two days', () => {
    expect(formatRelativeTime('2026-09-20T12:00:00Z', t, NOW)).toMatch(/Sep 20/);
  });

  it('renders nothing for an unparseable timestamp', () => {
    expect(formatRelativeTime('not a date', t, NOW)).toBe('');
  });
});
