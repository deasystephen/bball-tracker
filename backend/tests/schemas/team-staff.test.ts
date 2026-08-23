/**
 * Schema tests for the team staff management API (role matrix B2.3 / B2.7)
 */

import { addStaffSchema, updateStaffRoleSchema, staffRoleTypeSchema } from '../../src/api/teams/schemas';

const UUID_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

describe('Team staff schemas', () => {
  describe('staffRoleTypeSchema', () => {
    it.each(['HEAD_COACH', 'ASSISTANT_COACH', 'TEAM_MANAGER'])('accepts %s', (type) => {
      expect(staffRoleTypeSchema.safeParse(type).success).toBe(true);
    });

    it.each(['CUSTOM', 'Head Coach', 'head_coach', '', 42, null])('rejects %p', (type) => {
      expect(staffRoleTypeSchema.safeParse(type).success).toBe(false);
    });
  });

  describe('addStaffSchema', () => {
    it('accepts userId + roleType', () => {
      const result = addStaffSchema.safeParse({ userId: UUID_ID, roleType: 'ASSISTANT_COACH' });
      expect(result.success).toBe(true);
    });

    it('accepts email + roleType', () => {
      const result = addStaffSchema.safeParse({ email: 'coach@example.com', roleType: 'TEAM_MANAGER' });
      expect(result.success).toBe(true);
    });

    it('rejects when neither userId nor email is given', () => {
      const result = addStaffSchema.safeParse({ roleType: 'HEAD_COACH' });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe('Provide exactly one of userId or email');
    });

    it('rejects when both userId and email are given', () => {
      const result = addStaffSchema.safeParse({
        userId: UUID_ID,
        email: 'coach@example.com',
        roleType: 'HEAD_COACH',
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe('Provide exactly one of userId or email');
    });

    it('rejects an empty-string email', () => {
      expect(addStaffSchema.safeParse({ email: '', roleType: 'HEAD_COACH' }).success).toBe(false);
    });

    it('rejects a malformed email', () => {
      expect(addStaffSchema.safeParse({ email: 'not-an-email', roleType: 'HEAD_COACH' }).success).toBe(false);
    });

    it('rejects a non-UUID userId', () => {
      expect(addStaffSchema.safeParse({ userId: 'user-1', roleType: 'HEAD_COACH' }).success).toBe(false);
    });

    it('requires roleType', () => {
      const result = addStaffSchema.safeParse({ userId: UUID_ID });
      expect(result.success).toBe(false);
    });

    it('rejects CUSTOM and role names as roleType', () => {
      expect(addStaffSchema.safeParse({ userId: UUID_ID, roleType: 'CUSTOM' }).success).toBe(false);
      expect(addStaffSchema.safeParse({ userId: UUID_ID, roleType: 'Head Coach' }).success).toBe(false);
    });
  });

  describe('updateStaffRoleSchema', () => {
    it('accepts a valid roleType', () => {
      expect(updateStaffRoleSchema.safeParse({ roleType: 'HEAD_COACH' }).success).toBe(true);
    });

    it('requires roleType', () => {
      expect(updateStaffRoleSchema.safeParse({}).success).toBe(false);
    });

    it('rejects unknown roleType values', () => {
      expect(updateStaffRoleSchema.safeParse({ roleType: 'OWNER' }).success).toBe(false);
    });
  });
});
