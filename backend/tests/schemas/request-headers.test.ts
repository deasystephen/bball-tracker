/**
 * The correlation header contract (#963): what `X-Request-Id` and
 * `X-Hooplings-Client` accept. The mobile and web clients follow the same
 * contract (docs/architecture/backend-services.md, Logging).
 */

import {
  CLIENT_HEADER_MAX_LENGTH,
  clientHeaderSchema,
  parseClientHeader,
  parseRequestIdHeader,
  requestIdHeaderSchema,
} from '../../src/api/middleware/request-headers';

describe('X-Request-Id schema', () => {
  it.each([
    'a1b2c3d4-e5f6-4890-a234-567890abcdef',
    'A1B2C3D4-E5F6-4890-A234-567890ABCDEF',
    // Any version: a v7 id from a client that prefers time-ordered ids.
    '01920c3e-7c2a-7b3e-9f00-1a2b3c4d5e6f',
  ])('accepts the UUID %s verbatim', (value) => {
    expect(requestIdHeaderSchema.safeParse(value).success).toBe(true);
    expect(parseRequestIdHeader(value)).toBe(value);
  });

  it.each([
    ['a free-form string', 'trace-7'],
    ['an empty string', ''],
    ['a UUID without dashes', 'a1b2c3d4e5f64890a234567890abcdef'],
    ['a UUID in braces', '{a1b2c3d4-e5f6-4890-a234-567890abcdef}'],
    ['a UUID with trailing text', 'a1b2c3d4-e5f6-4890-a234-567890abcdef\nINJECTED'],
    ['a non-hex UUID shape', 'g1b2c3d4-e5f6-4890-a234-567890abcdef'],
    ['two joined header values', 'a1b2c3d4-e5f6-4890-a234-567890abcdef, a1b2c3d4-e5f6-4890-a234-567890abcdef'],
  ])('rejects %s', (_label, value) => {
    expect(requestIdHeaderSchema.safeParse(value).success).toBe(false);
    expect(parseRequestIdHeader(value)).toBeUndefined();
  });

  it('treats an absent or non-string header as missing', () => {
    expect(parseRequestIdHeader(undefined)).toBeUndefined();
    expect(parseRequestIdHeader(['a1b2c3d4-e5f6-4890-a234-567890abcdef'])).toBeUndefined();
  });
});

describe('X-Hooplings-Client schema', () => {
  it.each([
    'web',
    'ios/1.6.0',
    'android/1.6.0',
    'ios/1.6.0+01a15220-8b6d-7172-a9a5-2d5fce7c6954',
    'ios/1.6.0+embedded',
    'ios/2',
    'ios/1.6.0.12',
  ])('accepts %s', (value) => {
    expect(clientHeaderSchema.safeParse(value).success).toBe(true);
    expect(parseClientHeader(value)).toBe(value);
  });

  it.each([
    ['an empty string', ''],
    ['an unknown platform', 'windows/1.0.0'],
    ['a capitalised platform', 'iOS/1.6.0'],
    ['a platform without a version', 'ios'],
    ['a non-numeric version', 'ios/latest'],
    ['too many version parts', 'ios/1.2.3.4.5'],
    ['a suffix on web', 'web/abc'],
    ['spaces', 'ios/1.6.0 (iPhone)'],
    ['a URL', 'https://hooplings.com/invite/abcdefghijklmnop'],
    ['an email address', 'ios/1.6.0+someone@example.com'],
    ['a newline', 'web\n{"level":"error"}'],
    ['an empty build suffix', 'ios/1.6.0+'],
  ])('rejects %s', (_label, value) => {
    expect(clientHeaderSchema.safeParse(value).success).toBe(false);
    expect(parseClientHeader(value)).toBeUndefined();
  });

  it(`rejects anything longer than ${CLIENT_HEADER_MAX_LENGTH} characters`, () => {
    const atLimit = `ios/1.6.0+${'a'.repeat(40)}`;
    expect(atLimit.length).toBeLessThanOrEqual(CLIENT_HEADER_MAX_LENGTH);
    expect(parseClientHeader(atLimit)).toBe(atLimit);
    // The suffix itself is capped at 40, so the overall cap also holds.
    expect(parseClientHeader(`ios/1.6.0+${'a'.repeat(41)}`)).toBeUndefined();
    expect(parseClientHeader(`ios/1.6.0.1+${'a'.repeat(60)}`)).toBeUndefined();
  });

  it('treats an absent or non-string header as missing', () => {
    expect(parseClientHeader(undefined)).toBeUndefined();
    expect(parseClientHeader(['web'])).toBeUndefined();
  });
});
