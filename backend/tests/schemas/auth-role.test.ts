/**
 * Schema tests for PATCH /auth/me/role
 */

import { updateRoleSchema, SELF_SELECTABLE_ROLES } from '../../src/api/auth/schemas';

describe('updateRoleSchema', () => {
  it.each(SELF_SELECTABLE_ROLES)('accepts %s', (role) => {
    expect(updateRoleSchema.safeParse({ role }).success).toBe(true);
  });

  it.each(['ADMIN', 'PARENT', 'coach', '', null, undefined, 42])('rejects %p', (role) => {
    expect(updateRoleSchema.safeParse({ role }).success).toBe(false);
  });

  it('rejects a missing body', () => {
    expect(updateRoleSchema.safeParse({}).success).toBe(false);
    expect(updateRoleSchema.safeParse(undefined).success).toBe(false);
  });

  it('strips extra fields rather than letting them through', () => {
    const result = updateRoleSchema.safeParse({ role: 'COACH', subscriptionTier: 'LEAGUE' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ role: 'COACH' });
  });
});
