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

  it('names the length cap in its message', () => {
    const result = devLoginSchema.safeParse({ email: `${'a'.repeat(242)}@example.test` });
    expect(result.error?.issues.map((i) => i.message)).toEqual(['Email is too long']);
  });

  it.each([
    ['a missing email', {}, 'Email is required'],
    ['an empty email', { email: '' }, 'Email is required'],
    ['a whitespace-only email', { email: '   ' }, 'Email is required'],
    ['a number', { email: 1 }, 'Email must be a string'],
    ['an object (a Prisma filter)', { email: { contains: 'a' } }, 'Email must be a string'],
    ['an array', { email: ['frank.vogel@example.com'] }, 'Email must be a string'],
    ['null', { email: null }, 'Email must be a string'],
  ])('rejects %s with one message', (_label, body, message) => {
    const result = devLoginSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([message]);
  });

  it('rejects a missing body', () => {
    expect(devLoginSchema.safeParse(undefined).success).toBe(false);
  });
});
