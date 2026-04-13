/**
 * Tests for the pure helpers exported from hooks/useTeams.ts.
 *
 * hasTeamPermission / isHeadCoach / getUserTeamRole are authorization
 * helpers — they gate UI features, so their correctness matters. These
 * are plain functions with no React coupling, which makes them easy to
 * test at the behavior level.
 */

import {
  hasTeamPermission,
  isHeadCoach,
  getUserTeamRole,
  Team,
  TeamStaff,
} from '../../hooks/useTeams';

const coachRole: TeamStaff['role'] = {
  id: 'r-head',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

const assistantRole: TeamStaff['role'] = {
  id: 'r-asst',
  name: 'Assistant Coach',
  type: 'ASSISTANT_COACH',
  canManageTeam: false,
  canManageRoster: false,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: false,
};

const team: Team = {
  id: 't1',
  name: 'Lakers',
  seasonId: 's1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  staff: [
    { id: 'ts1', userId: 'u-head', user: { id: 'u-head', name: 'A', email: 'a@x' }, role: coachRole },
    { id: 'ts2', userId: 'u-asst', user: { id: 'u-asst', name: 'B', email: 'b@x' }, role: assistantRole },
  ],
};

describe('useTeams pure helpers', () => {
  describe('hasTeamPermission', () => {
    it('returns false when team is undefined', () => {
      expect(hasTeamPermission(undefined, 'u-head', 'canManageTeam')).toBe(false);
    });
    it('returns false when userId is undefined', () => {
      expect(hasTeamPermission(team, undefined, 'canManageTeam')).toBe(false);
    });
    it('returns false when user is not on staff', () => {
      expect(hasTeamPermission(team, 'stranger', 'canManageTeam')).toBe(false);
    });
    it('returns true when the staff role grants the permission', () => {
      expect(hasTeamPermission(team, 'u-head', 'canManageTeam')).toBe(true);
      expect(hasTeamPermission(team, 'u-asst', 'canTrackStats')).toBe(true);
    });
    it('returns false when the role lacks the permission', () => {
      expect(hasTeamPermission(team, 'u-asst', 'canManageTeam')).toBe(false);
      expect(hasTeamPermission(team, 'u-asst', 'canShareStats')).toBe(false);
    });
  });

  describe('isHeadCoach', () => {
    it('returns false for unknown team/user', () => {
      expect(isHeadCoach(undefined, 'u-head')).toBe(false);
      expect(isHeadCoach(team, undefined)).toBe(false);
    });
    it('returns true only for users with role.type === HEAD_COACH', () => {
      expect(isHeadCoach(team, 'u-head')).toBe(true);
      expect(isHeadCoach(team, 'u-asst')).toBe(false);
      expect(isHeadCoach(team, 'stranger')).toBe(false);
    });
  });

  describe('getUserTeamRole', () => {
    it('returns null when team/user missing or user not on staff', () => {
      expect(getUserTeamRole(undefined, 'u-head')).toBeNull();
      expect(getUserTeamRole(team, undefined)).toBeNull();
      expect(getUserTeamRole(team, 'stranger')).toBeNull();
    });
    it('returns the matching role object for a staff member', () => {
      expect(getUserTeamRole(team, 'u-head')).toEqual(coachRole);
      expect(getUserTeamRole(team, 'u-asst')).toEqual(assistantRole);
    });
  });
});
