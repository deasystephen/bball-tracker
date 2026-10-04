/**
 * Schema tests for POST and DELETE /auth/push-token (#649)
 */

import { registerPushTokenSchema, removePushTokenSchema } from '../../src/api/auth/schemas';

const TOKEN = 'ExponentPushToken[abc123]';

describe('removePushTokenSchema', () => {
  it('accepts a non-empty string token', () => {
    const result = removePushTokenSchema.safeParse({ token: TOKEN });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ token: TOKEN });
  });

  it.each([{}, { contains: '' }, { not: '' }, 123, ['x'], true, null])('rejects non-string token %p', (token) => {
    const result = removePushTokenSchema.safeParse({ token });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Token must be a string');
  });

  it('rejects an empty or missing token with Token is required', () => {
    for (const body of [{ token: '' }, {}]) {
      const result = removePushTokenSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe('Token is required');
    }
  });

  it('strips extra fields', () => {
    const result = removePushTokenSchema.safeParse({ token: TOKEN, userId: 'someone-else' });
    expect(result.data).toEqual({ token: TOKEN });
  });
});

describe('registerPushTokenSchema', () => {
  it.each(['ios', 'android'])('accepts platform %s', (platform) => {
    expect(registerPushTokenSchema.safeParse({ token: TOKEN, platform }).success).toBe(true);
  });

  it('rejects an unknown platform', () => {
    expect(registerPushTokenSchema.safeParse({ token: TOKEN, platform: 'windows' }).success).toBe(false);
  });

  it.each([{}, 123, '', undefined])('rejects token %p', (token) => {
    expect(registerPushTokenSchema.safeParse({ token, platform: 'ios' }).success).toBe(false);
  });
});
