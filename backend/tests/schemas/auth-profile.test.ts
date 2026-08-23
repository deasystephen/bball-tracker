/**
 * Schema tests for updateProfileSchema (PATCH /auth/me)
 */

import { updateProfileSchema } from '../../src/api/auth/schemas';

describe('updateProfileSchema', () => {
  it('accepts a name only', () => {
    const result = updateProfileSchema.safeParse({ name: 'Coach Carter' });
    expect(result.success).toBe(true);
  });

  it('trims the name', () => {
    const result = updateProfileSchema.safeParse({ name: '  Coach  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('Coach');
  });

  it('accepts an https avatar URL only', () => {
    expect(updateProfileSchema.safeParse({ profilePictureUrl: 'https://cdn.example.com/a.jpg' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ profilePictureUrl: 'http://cdn.example.com/a.jpg' }).success).toBe(true);
  });

  it('accepts an empty string to clear the avatar', () => {
    const result = updateProfileSchema.safeParse({ profilePictureUrl: '' });
    expect(result.success).toBe(true);
  });

  it('accepts both fields together', () => {
    expect(updateProfileSchema.safeParse({ name: 'A', profilePictureUrl: 'https://x.test/a.png' }).success).toBe(true);
  });

  it('rejects an empty object', () => {
    const result = updateProfileSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty or whitespace name', () => {
    expect(updateProfileSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects a name over 100 characters', () => {
    expect(updateProfileSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
  });

  it('rejects non-http(s) and malformed avatar URLs', () => {
    expect(updateProfileSchema.safeParse({ profilePictureUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ profilePictureUrl: 'ftp://x.test/a.png' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ profilePictureUrl: 'not a url' }).success).toBe(false);
  });

  it('ignores email and role (not editable here)', () => {
    const result = updateProfileSchema.safeParse({ name: 'A', email: 'x@y.z', role: 'ADMIN' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'A' });
    }
  });
});
