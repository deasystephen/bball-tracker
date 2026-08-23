/**
 * Zod schema tests for the league-admin endpoints (decision 3)
 */

import { addLeagueAdminSchema } from '../../src/api/leagues/schemas';

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
