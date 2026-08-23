/**
 * Schema tests for the OAuth state + PKCE query params (audit #5).
 */

import {
  oauthStateSchema,
  pkceChallengeSchema,
  pkceVerifierSchema,
  loginQuerySchema,
  callbackQuerySchema,
} from '../../src/api/auth/schemas';

// RFC 7636 Appendix B vectors.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const STATE = '0123456789abcdef0123456789abcdef';

describe('oauthStateSchema', () => {
  it('accepts 16–256 chars of [A-Za-z0-9_-]', () => {
    expect(oauthStateSchema.safeParse(STATE).success).toBe(true);
    expect(oauthStateSchema.safeParse('a'.repeat(16)).success).toBe(true);
    expect(oauthStateSchema.safeParse('a-_'.repeat(85) + 'a').success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', 'a'.repeat(15)],
    ['too long', 'a'.repeat(257)],
    ['space', 'a'.repeat(16) + ' '],
    ['plus/slash/equals', 'a'.repeat(16) + '+/='],
  ])('rejects %s', (_label, value) => {
    expect(oauthStateSchema.safeParse(value).success).toBe(false);
  });
});

describe('pkceChallengeSchema / pkceVerifierSchema', () => {
  it('accept RFC 7636 vectors and the full unreserved alphabet', () => {
    expect(pkceChallengeSchema.safeParse(CHALLENGE).success).toBe(true);
    expect(pkceVerifierSchema.safeParse(VERIFIER).success).toBe(true);
    expect(pkceVerifierSchema.safeParse('Az09-._~'.repeat(16)).success).toBe(true); // 128 chars
  });

  it.each([
    ['42 chars (too short)', 'a'.repeat(42)],
    ['129 chars (too long)', 'a'.repeat(129)],
    ['standard base64 padding', 'a'.repeat(42) + '='],
    ['plus sign', 'a'.repeat(42) + '+'],
  ])('reject %s', (_label, value) => {
    expect(pkceChallengeSchema.safeParse(value).success).toBe(false);
    expect(pkceVerifierSchema.safeParse(value).success).toBe(false);
  });
});

describe('loginQuerySchema', () => {
  it('accepts neither or both of state/code_challenge', () => {
    expect(loginQuerySchema.safeParse({}).success).toBe(true);
    expect(loginQuerySchema.safeParse({ state: STATE, code_challenge: CHALLENGE }).success).toBe(true);
  });

  it('rejects one without the other', () => {
    const a = loginQuerySchema.safeParse({ state: STATE });
    expect(a.success).toBe(false);
    expect(a.error?.issues[0]?.message).toMatch(/together/);
    expect(loginQuerySchema.safeParse({ code_challenge: CHALLENGE }).success).toBe(false);
  });
});

describe('callbackQuerySchema', () => {
  it('requires a non-empty code', () => {
    expect(callbackQuerySchema.safeParse({ code: '' }).success).toBe(false);
    expect(callbackQuerySchema.safeParse({}).success).toBe(false);
    expect(callbackQuerySchema.safeParse({ code: 'abc' }).success).toBe(true);
  });

  it('accepts code + state + code_verifier together', () => {
    expect(callbackQuerySchema.safeParse({ code: 'abc', state: STATE, code_verifier: VERIFIER }).success).toBe(true);
  });

  it('rejects state or code_verifier alone', () => {
    expect(callbackQuerySchema.safeParse({ code: 'abc', state: STATE }).success).toBe(false);
    const r = callbackQuerySchema.safeParse({ code: 'abc', code_verifier: VERIFIER });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/together/);
  });

  it('surfaces the field-level message for a malformed verifier', () => {
    const r = callbackQuerySchema.safeParse({ code: 'abc', state: STATE, code_verifier: 'short' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Invalid code_verifier');
  });
});
