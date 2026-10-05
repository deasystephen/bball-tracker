/**
 * Schema tests for POST /auth/refresh (#693). The schema was module-local in
 * `src/api/auth/routes.ts` until it moved to `src/api/auth/schemas.ts`.
 */

import { refreshSchema } from '../../src/api/auth/schemas';

describe('refreshSchema', () => {
  it('accepts a refresh token', () => {
    expect(refreshSchema.safeParse({ refreshToken: 'rt_abc' }).data).toEqual({ refreshToken: 'rt_abc' });
  });

  it.each([
    ['a missing refreshToken', {}],
    ['an empty refreshToken', { refreshToken: '' }],
    ['a non-string refreshToken', { refreshToken: 123 }],
    ['an object refreshToken', { refreshToken: { token: 'rt_abc' } }],
  ])('rejects %s', (_label, body) => {
    expect(refreshSchema.safeParse(body).success).toBe(false);
  });
});
