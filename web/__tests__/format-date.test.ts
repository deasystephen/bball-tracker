import { describe, expect, it } from 'vitest';
import { formatExpiry } from '../lib/format-date';

describe('formatExpiry', () => {
  it('formats in UTC with a fixed locale, so server and browser agree', () => {
    // 23:30 UTC is already the next day east of UTC and still this day in UTC.
    expect(formatExpiry('2026-10-24T23:30:00.000Z')).toBe('October 24, 2026');
    expect(formatExpiry('2026-10-25T00:30:00.000Z')).toBe('October 25, 2026');
  });

  it('ignores the host time zone', () => {
    const original = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(formatExpiry('2026-10-24T23:30:00.000Z')).toBe('October 24, 2026');
    } finally {
      process.env.TZ = original;
    }
  });
});
