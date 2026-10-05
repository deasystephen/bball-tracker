/**
 * Zod schema tests for the league endpoints: league admins (decision 3) and
 * the create/update name caps (#693).
 */

import { addLeagueAdminSchema, createLeagueSchema, updateLeagueSchema } from '../../src/api/leagues/schemas';

const VALID_USER_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';

describe('addLeagueAdminSchema', () => {
  it('accepts a UUID userId', () => {
    const result = addLeagueAdminSchema.safeParse({ userId: VALID_USER_ID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ userId: VALID_USER_ID });
    }
  });

  it('rejects a missing userId', () => {
    const result = addLeagueAdminSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = addLeagueAdminSchema.safeParse({ userId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID (user ids are UUIDs, unlike league/season ids)', () => {
    const result = addLeagueAdminSchema.safeParse({ userId: 'downtown-youth-league' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('userId must be a valid UUID');
    }
  });

  it('rejects a non-string userId', () => {
    expect(addLeagueAdminSchema.safeParse({ userId: 123 }).success).toBe(false);
    expect(addLeagueAdminSchema.safeParse({ userId: null }).success).toBe(false);
  });

  it('ignores unknown fields', () => {
    const result = addLeagueAdminSchema.safeParse({ userId: VALID_USER_ID, role: 'ADMIN' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('role');
    }
  });
});

describe('createLeagueSchema', () => {
  it('accepts a 1-character and a 100-character name', () => {
    expect(createLeagueSchema.safeParse({ name: 'A' }).success).toBe(true);
    expect(createLeagueSchema.safeParse({ name: 'A'.repeat(100) }).success).toBe(true);
  });

  it.each([
    ['a missing name', {}],
    ['an empty name', { name: '' }],
    ['a 101-character name', { name: 'A'.repeat(101) }],
    ['a non-string name', { name: 42 }],
  ])('rejects %s', (_label, body) => {
    expect(createLeagueSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateLeagueSchema', () => {
  it('accepts an empty body (every field is optional)', () => {
    const result = updateLeagueSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('accepts a 100-character name', () => {
    expect(updateLeagueSchema.safeParse({ name: 'A'.repeat(100) }).success).toBe(true);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a 101-character name', { name: 'A'.repeat(101) }],
  ])('rejects %s', (_label, body) => {
    expect(updateLeagueSchema.safeParse(body).success).toBe(false);
  });
});
