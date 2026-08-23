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
  canManageStaff,
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
    it('grants every permission to a system ADMIN even without a staff row (audit #79)', () => {
      expect(hasTeamPermission(team, 'stranger', 'canManageTeam', 'ADMIN')).toBe(true);
      expect(hasTeamPermission(team, 'u-asst', 'canManageTeam', 'ADMIN')).toBe(true);
      expect(hasTeamPermission(team, 'stranger', 'canShareStats', 'ADMIN')).toBe(true);
    });
    it('does not grant extra permissions to COACH/PLAYER roles', () => {
      expect(hasTeamPermission(team, 'stranger', 'canManageTeam', 'COACH')).toBe(false);
      expect(hasTeamPermission(team, 'u-asst', 'canManageTeam', 'PLAYER')).toBe(false);
      expect(hasTeamPermission(team, 'u-asst', 'canTrackStats', null)).toBe(true);
    });
    it('still requires a team and user id for ADMIN', () => {
      expect(hasTeamPermission(undefined, 'u-head', 'canManageTeam', 'ADMIN')).toBe(false);
      expect(hasTeamPermission(team, undefined, 'canManageTeam', 'ADMIN')).toBe(false);
    });

    describe('league admins (leagueAdminOf from GET /auth/me)', () => {
      const leagueTeam: Team = {
        ...team,
        season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
      };

      it('grants every permission on teams in an administered league', () => {
        expect(hasTeamPermission(leagueTeam, 'stranger', 'canManageTeam', 'PLAYER', ['league-1'])).toBe(true);
        expect(hasTeamPermission(leagueTeam, 'stranger', 'canTrackStats', 'COACH', ['league-1'])).toBe(true);
        expect(hasTeamPermission(leagueTeam, 'u-asst', 'canManageTeam', 'COACH', ['x', 'league-1'])).toBe(true);
      });

      it('does not apply to other leagues, an empty/undefined list, or a team without season info', () => {
        expect(hasTeamPermission(leagueTeam, 'stranger', 'canManageTeam', 'PLAYER', ['league-2'])).toBe(false);
        expect(hasTeamPermission(leagueTeam, 'stranger', 'canManageTeam', 'PLAYER', [])).toBe(false);
        expect(hasTeamPermission(leagueTeam, 'stranger', 'canManageTeam', 'PLAYER', undefined)).toBe(false);
        expect(hasTeamPermission(team, 'stranger', 'canManageTeam', 'PLAYER', ['league-1'])).toBe(false);
      });

      it('still falls through to the staff role when not a league admin', () => {
        expect(hasTeamPermission(leagueTeam, 'u-asst', 'canTrackStats', 'COACH', ['league-2'])).toBe(true);
        expect(hasTeamPermission(leagueTeam, 'u-asst', 'canManageTeam', 'COACH', ['league-2'])).toBe(false);
      });
    });
  });

  describe('canManageStaff (role matrix decision 2, B2.3)', () => {
    const leagueTeam: Team = {
      ...team,
      season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
    };

    it('head coach (HEAD_COACH-type staff row) may manage staff', () => {
      expect(canManageStaff(team, 'u-head', 'COACH')).toBe(true);
      expect(canManageStaff(team, 'u-head')).toBe(true);
    });
    it('assistant coach may not, despite sharing the same permission flags', () => {
      expect(canManageStaff(team, 'u-asst', 'COACH')).toBe(false);
    });
    it('a team manager / non-staff user may not', () => {
      const managerTeam: Team = {
        ...team,
        staff: [
          ...(team.staff ?? []),
          {
            id: 'ts3',
            userId: 'u-mgr',
            user: { id: 'u-mgr', name: 'C' },
            role: { ...coachRole, id: 'r-mgr', name: 'Team Manager', type: 'TEAM_MANAGER' },
          },
        ],
      };
      expect(canManageStaff(managerTeam, 'u-mgr', 'COACH')).toBe(false);
      expect(canManageStaff(team, 'stranger', 'COACH')).toBe(false);
    });
    it('league admin of the team league may manage staff; other leagues do not count', () => {
      expect(canManageStaff(leagueTeam, 'stranger', 'PLAYER', ['league-1'])).toBe(true);
      expect(canManageStaff(leagueTeam, 'u-asst', 'COACH', ['league-1'])).toBe(true);
      expect(canManageStaff(leagueTeam, 'stranger', 'COACH', ['league-2'])).toBe(false);
      expect(canManageStaff(team, 'stranger', 'COACH', ['league-1'])).toBe(false);
    });
    it('system ADMIN may manage staff without a staff row', () => {
      expect(canManageStaff(team, 'stranger', 'ADMIN')).toBe(true);
    });
    it('requires a team and a user id', () => {
      expect(canManageStaff(undefined, 'u-head', 'ADMIN')).toBe(false);
      expect(canManageStaff(team, undefined, 'ADMIN')).toBe(false);
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
