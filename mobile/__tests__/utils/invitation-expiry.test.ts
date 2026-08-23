import { formatInvitationExpiry, isInvitationExpired } from '../../utils/invitation-expiry';

const NOW = new Date('2026-08-23T12:00:00Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();

describe('formatInvitationExpiry (audit #59)', () => {
  it('says Expired for anything in the past, including within the last 24h', () => {
    // Math.ceil(-0.5) === -0, which the old code rendered as "Expires today"
    expect(formatInvitationExpiry(hours(-12), NOW)).toBe('Expired');
    expect(formatInvitationExpiry(hours(-0.01), NOW)).toBe('Expired');
    expect(formatInvitationExpiry(hours(-72), NOW)).toBe('Expired');
  });

  it('says Expired at the exact expiry instant', () => {
    expect(formatInvitationExpiry(NOW.toISOString(), NOW)).toBe('Expired');
  });

  it('says Expires today for less than 24h remaining', () => {
    expect(formatInvitationExpiry(hours(0.5), NOW)).toBe('Expires today');
    expect(formatInvitationExpiry(hours(23.9), NOW)).toBe('Expires today');
  });

  it('says Expires tomorrow for 24h to 48h remaining', () => {
    expect(formatInvitationExpiry(hours(24), NOW)).toBe('Expires tomorrow');
    expect(formatInvitationExpiry(hours(47.9), NOW)).toBe('Expires tomorrow');
  });

  it('counts whole days beyond that', () => {
    expect(formatInvitationExpiry(hours(48), NOW)).toBe('Expires in 2 days');
    expect(formatInvitationExpiry(hours(7 * 24 - 1), NOW)).toBe('Expires in 7 days');
  });

  it('treats an unparseable date as expired', () => {
    expect(formatInvitationExpiry('not-a-date', NOW)).toBe('Expired');
  });
});

describe('isInvitationExpired', () => {
  it('is true at or after expiry and false before', () => {
    expect(isInvitationExpired(hours(-1), NOW)).toBe(true);
    expect(isInvitationExpired(NOW, NOW)).toBe(true);
    expect(isInvitationExpired(hours(1), NOW)).toBe(false);
  });
});
