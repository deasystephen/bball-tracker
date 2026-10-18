import { isTokenUnexpired, tokenExpiresAt, tokenIssuedAt } from '../../utils/token-expiry';

const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: object): string => `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`;
const dev = (payload: object): string => `dev_${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

describe('tokenExpiresAt', () => {
  it('reads a JWT exp (seconds) as epoch ms, including base64url characters', () => {
    // A `sub` long enough to need padding and URL-safe characters.
    expect(tokenExpiresAt(jwt({ sub: 'user_01?>~~', exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it('reads a dev token exp (already ms)', () => {
    expect(tokenExpiresAt(dev({ userId: 'u1', exp: 1_800_000_000_000 }))).toBe(1_800_000_000_000);
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['not a JWT', 'opaque-token'],
    ['garbage payload', 'a.!!!.c'],
    ['no exp', jwt({ sub: 'u' })],
    ['string exp', jwt({ sub: 'u', exp: '1800000000' })],
    ['dev string exp', dev({ userId: 'u', exp: '1800000000000' })],
  ])('returns null for %s', (_label, token) => {
    expect(tokenExpiresAt(token)).toBeNull();
  });
});

describe('isTokenUnexpired', () => {
  const now = 1_800_000_000_000;
  it('is true only for a decodable token that expires after now', () => {
    expect(isTokenUnexpired(jwt({ exp: now / 1000 + 60 }), now)).toBe(true);
    expect(isTokenUnexpired(jwt({ exp: now / 1000 - 1 }), now)).toBe(false);
    expect(isTokenUnexpired('opaque-token', now)).toBe(false);
  });
});

describe('tokenIssuedAt', () => {
  it('reads a JWT iat (seconds) as epoch ms', () => {
    expect(tokenIssuedAt(jwt({ iat: 1_799_999_700, exp: 1_800_000_000 }))).toBe(1_799_999_700_000);
  });

  it('returns null when there is no numeric iat', () => {
    expect(tokenIssuedAt(jwt({ exp: 1_800_000_000 }))).toBeNull();
    expect(tokenIssuedAt(dev({ userId: 'u', exp: 1_800_000_000_000 }))).toBeNull();
    expect(tokenIssuedAt('opaque-token')).toBeNull();
  });
});
