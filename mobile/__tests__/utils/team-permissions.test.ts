import {
  canAccessAdmin,
  canCreateLeagues,
  canCreateTeams,
  canManageLeague,
  isLeagueAdminOf,
} from '../../utils/team-permissions';
import { UserRole } from '../../../shared/types';

describe('canCreateTeams', () => {
  it.each([UserRole.COACH, UserRole.ADMIN])('allows %s', (role) => {
    expect(canCreateTeams({ role })).toBe(true);
  });

  it.each([UserRole.PLAYER, UserRole.PARENT])('denies %s', (role) => {
    expect(canCreateTeams({ role })).toBe(false);
  });

  it('allows a PLAYER who administers a league', () => {
    expect(canCreateTeams({ role: UserRole.PLAYER, leagueAdminOf: ['league-1'] })).toBe(true);
  });

  it('treats a missing leagueAdminOf as no leagues', () => {
    expect(canCreateTeams({ role: UserRole.PLAYER, leagueAdminOf: undefined })).toBe(false);
    expect(canCreateTeams({ role: UserRole.PLAYER, leagueAdminOf: [] })).toBe(false);
  });

  it('denies a missing user', () => {
    expect(canCreateTeams(null)).toBe(false);
    expect(canCreateTeams(undefined)).toBe(false);
  });
});

describe('league admin helpers', () => {
  const leagueAdmin = { role: UserRole.PLAYER, leagueAdminOf: ['league-1'] };
  const coach = { role: UserRole.COACH };
  const admin = { role: UserRole.ADMIN };

  it('isLeagueAdminOf matches only the listed leagues (ADMIN matches all)', () => {
    expect(isLeagueAdminOf(leagueAdmin, 'league-1')).toBe(true);
    expect(isLeagueAdminOf(leagueAdmin, 'league-2')).toBe(false);
    expect(isLeagueAdminOf(leagueAdmin, undefined)).toBe(false);
    expect(isLeagueAdminOf(admin, 'anything')).toBe(true);
    expect(isLeagueAdminOf(coach, 'league-1')).toBe(false);
    expect(isLeagueAdminOf(null, 'league-1')).toBe(false);
  });

  it('canAccessAdmin: ADMIN or at least one league', () => {
    expect(canAccessAdmin(admin)).toBe(true);
    expect(canAccessAdmin(leagueAdmin)).toBe(true);
    expect(canAccessAdmin(coach)).toBe(false);
    expect(canAccessAdmin({ role: UserRole.PLAYER, leagueAdminOf: [] })).toBe(false);
    expect(canAccessAdmin(undefined)).toBe(false);
  });

  it('canCreateLeagues stays ADMIN-only', () => {
    expect(canCreateLeagues(admin)).toBe(true);
    expect(canCreateLeagues(leagueAdmin)).toBe(false);
    expect(canCreateLeagues(coach)).toBe(false);
  });

  it('canManageLeague: ADMIN or admin of that league', () => {
    expect(canManageLeague(admin, 'league-9')).toBe(true);
    expect(canManageLeague(leagueAdmin, 'league-1')).toBe(true);
    expect(canManageLeague(leagueAdmin, 'league-9')).toBe(false);
    expect(canManageLeague(coach, 'league-1')).toBe(false);
  });
});
