/**
 * The authenticated caller as `authenticate` attaches it (`req.user`), and the
 * development-only dev token it accepts (`Bearer dev_<base64 JSON>`).
 */
import type { Request } from 'express';

export type AuthUser = NonNullable<Request['user']>;

/** The fields `authenticate` selects (`AUTH_USER_SELECT`); a COACH on the FREE tier, age confirmed, by default. */
export function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
    email: 'coach@example.com',
    name: 'Coach',
    role: 'COACH',
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
    ageConfirmedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** A dev token for `userId`, valid for a minute unless `exp` (epoch ms) says otherwise. */
export function devToken(payload: { userId: string; exp?: number }): string {
  const body = { userId: payload.userId, exp: payload.exp ?? Date.now() + 60_000 };
  return `dev_${Buffer.from(JSON.stringify(body)).toString('base64')}`;
}
