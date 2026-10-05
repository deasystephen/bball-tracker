/**
 * Schema tests for POST /auth/dev-login (#692). The route is development
 * only; it signs in local development and every Maestro flow.
 */

import { devLoginSchema } from '../../src/api/auth/schemas';

describe('devLoginSchema', () => {
  it('accepts a seeded address', () => {
    const result = devLoginSchema.safeParse({ email: 'frank.vogel@example.com' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ email: 'frank.vogel@example.com' });
  });

  it('trims surrounding whitespace', () => {
    expect(devLoginSchema.safeParse({ email: '  frank.vogel@example.com\n' }).data?.email).toBe(
      'frank.vogel@example.com'
    );
  });

  it('accepts a 254-character address and rejects a 255-character one', () => {
    const local = (n: number): string => 'a'.repeat(n - '@example.test'.length);
    expect(devLoginSchema.safeParse({ email: `${local(254)}@example.test` }).success).toBe(true);
    expect(devLoginSchema.safeParse({ email: `${local(255)}@example.test` }).success).toBe(false);
  });

  it.each([
    ['a missing email', {}],
    ['an empty email', { email: '' }],
    ['a whitespace-only email', { email: '   ' }],
    ['a number', { email: 1 }],
    ['an object (a Prisma filter)', { email: { contains: 'a' } }],
    ['an array', { email: ['frank.vogel@example.com'] }],
    ['null', { email: null }],
  ])('rejects %s', (_label, body) => {
    expect(devLoginSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a missing body', () => {
    expect(devLoginSchema.safeParse(undefined).success).toBe(false);
  });
});
