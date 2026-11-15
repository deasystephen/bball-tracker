/**
 * Schema validation for `POST /teams/:teamId/staff-invitations` (#460).
 */

import { inviteStaffSchema } from '../../src/api/teams/schemas';

describe('inviteStaffSchema', () => {
  it('trims and lower-cases the address (the form every invitation stores) and defaults supersede', () => {
    const result = inviteStaffSchema.safeParse({ email: '  New.Coach@Example.COM ', roleType: 'ASSISTANT_COACH' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ email: 'new.coach@example.com', roleType: 'ASSISTANT_COACH', supersede: false });
    }
  });

  it.each(['HEAD_COACH', 'ASSISTANT_COACH', 'TEAM_MANAGER'])('accepts role type %s', (roleType) => {
    expect(inviteStaffSchema.safeParse({ email: 'c@example.com', roleType }).success).toBe(true);
  });

  it.each(['CUSTOM', 'head_coach', '', undefined])('rejects role type %p with the shared message', (roleType) => {
    const result = inviteStaffSchema.safeParse({ email: 'c@example.com', roleType });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('roleType must be one of');
    }
  });

  it.each(['', 'not-an-email', 'a@', '@example.com', '   '])('rejects the address %p', (email) => {
    const result = inviteStaffSchema.safeParse({ email, roleType: 'HEAD_COACH' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid email format');
    }
  });

  it('rejects a missing address', () => {
    expect(inviteStaffSchema.safeParse({ roleType: 'HEAD_COACH' }).success).toBe(false);
  });

  it('rejects an address longer than 255 characters', () => {
    const email = `${'a'.repeat(250)}@example.com`;
    expect(inviteStaffSchema.safeParse({ email, roleType: 'HEAD_COACH' }).success).toBe(false);
  });

  it('accepts supersede: true and rejects a non-boolean supersede', () => {
    expect(inviteStaffSchema.safeParse({ email: 'c@example.com', roleType: 'HEAD_COACH', supersede: true }).success).toBe(true);
    expect(inviteStaffSchema.safeParse({ email: 'c@example.com', roleType: 'HEAD_COACH', supersede: 'yes' }).success).toBe(false);
  });

  it('strips unknown keys such as a userId or a token', () => {
    const result = inviteStaffSchema.safeParse({
      email: 'c@example.com',
      roleType: 'HEAD_COACH',
      userId: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      token: 'x',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('userId');
      expect(result.data).not.toHaveProperty('token');
    }
  });
});
