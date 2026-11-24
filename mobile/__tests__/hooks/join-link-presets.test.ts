/**
 * The join link presets (#1073) stay inside the API's bounds
 * (`backend/src/api/join/schemas.ts`: `expiresInDays` 1 to 30, default 14;
 * `maxUses` 1 to 500 or null). A preset outside them would be a 400 on tap.
 */
import {
  JOIN_LINK_DEFAULT_EXPIRES_DAYS,
  JOIN_LINK_EXPIRY_PRESETS,
  JOIN_LINK_MAX_EXPIRES_DAYS,
  JOIN_LINK_MAX_USES,
  JOIN_LINK_MAX_USES_PRESETS,
} from '../../hooks/useJoinLink';

describe('join link presets', () => {
  it('mirror the API bounds and default', () => {
    expect(JOIN_LINK_DEFAULT_EXPIRES_DAYS).toBe(14);
    expect(JOIN_LINK_MAX_EXPIRES_DAYS).toBe(30);
    expect(JOIN_LINK_MAX_USES).toBe(500);
  });

  it('offer the default expiry, and only whole days from 1 to 30', () => {
    expect(JOIN_LINK_EXPIRY_PRESETS).toContain(JOIN_LINK_DEFAULT_EXPIRES_DAYS);
    for (const days of JOIN_LINK_EXPIRY_PRESETS) {
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(JOIN_LINK_MAX_EXPIRES_DAYS);
    }
  });

  it('offer only whole caps from 1 to 500 ("No limit" is null, not a preset)', () => {
    for (const cap of JOIN_LINK_MAX_USES_PRESETS) {
      expect(Number.isInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(1);
      expect(cap).toBeLessThanOrEqual(JOIN_LINK_MAX_USES);
    }
  });
});
