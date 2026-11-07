/**
 * Schema tests for `POST /auth/age-confirmation` (#981): month 1–12, a sane
 * year, an optional two-letter region, nothing else.
 */
import { ageConfirmationSchema } from '../../src/api/auth/schemas';

describe('ageConfirmationSchema', () => {
  it('accepts a month and a year', () => {
    const result = ageConfirmationSchema.safeParse({ birthMonth: 3, birthYear: 1990 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ birthMonth: 3, birthYear: 1990 });
  });

  it('accepts and upper-cases a two-letter region code', () => {
    const result = ageConfirmationSchema.safeParse({ birthMonth: 3, birthYear: 1990, regionCode: ' de ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.regionCode).toBe('DE');
  });

  it('refuses a month outside 1–12, a fractional month, or a string', () => {
    expect(ageConfirmationSchema.safeParse({ birthMonth: 0, birthYear: 1990 }).success).toBe(false);
    expect(ageConfirmationSchema.safeParse({ birthMonth: 13, birthYear: 1990 }).success).toBe(false);
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1.5, birthYear: 1990 }).success).toBe(false);
    expect(ageConfirmationSchema.safeParse({ birthMonth: '3', birthYear: 1990 }).success).toBe(false);
  });

  it('refuses a year before 1900 or after this year', () => {
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1, birthYear: 1899 }).success).toBe(false);
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1, birthYear: new Date().getUTCFullYear() }).success).toBe(true);
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1, birthYear: new Date().getUTCFullYear() + 1 }).success).toBe(false);
  });

  it('refuses a malformed region and any extra field (nothing but the answer travels)', () => {
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1, birthYear: 1990, regionCode: 'USA' }).success).toBe(false);
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1, birthYear: 1990, regionCode: '1a' }).success).toBe(false);
    expect(ageConfirmationSchema.safeParse({ birthMonth: 1, birthYear: 1990, birthDay: 4 }).success).toBe(false);
  });

  it('never quotes the submitted value in a validation message', () => {
    const result = ageConfirmationSchema.safeParse({ birthMonth: 42, birthYear: 2031 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(' ');
      expect(messages).not.toContain('42');
      expect(messages).not.toContain('2031');
    }
  });

  it('refuses a missing body', () => {
    expect(ageConfirmationSchema.safeParse({}).success).toBe(false);
    expect(ageConfirmationSchema.safeParse(undefined).success).toBe(false);
  });
});
