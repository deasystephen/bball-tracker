/**
 * getGamePermissions / canManageAnyTeam mirror the backend game rules
 * (game-service / game-event-service) so players never see controls that
 * the API rejects with 403.
 */

import { canManageAnyTeam, getGamePermissions } from '../../utils/game-permissions';
import type { TeamStaff } from '../../hooks/useTeams';

const role = (flags: Partial<TeamStaff['role']>): TeamStaff['role'] => ({
  id: 'r',
  name: 'Role',
  type: 'CUSTOM',
  canManageTeam: false,
  canManageRoster: false,
  canTrackStats: false,
  canViewStats: true,
  canShareStats: false,
  ...flags,
});

const staff = (userId: string, flags: Partial<TeamStaff['role']>): TeamStaff => ({
  id: `ts-${userId}`,
  userId,
  user: { id: userId, name: userId, email: `${userId}@x` },
  role: role(flags),
});

const team = {
  staff: [
    staff('head', { canManageTeam: true, canManageRoster: true, canTrackStats: true }),
    staff('scorer', { canTrackStats: true }),
    staff('manager', { canManageTeam: true }),
  ],
  season: { league: { id: 'league-1' } },
};

describe('getGamePermissions', () => {
  it('denies everything without a team or user', () => {
    expect(getGamePermissions(undefined, { id: 'head', role: 'COACH' })).toEqual({
      canManage: false,
      canTrack: false,
      canChangeStatus: false,
      canEditFinished: false,
    });
    expect(getGamePermissions(team, null).canTrack).toBe(false);
  });

  it('head coach: manage, track, status, finished edits', () => {
    expect(getGamePermissions(team, { id: 'head', role: 'COACH' })).toEqual({
      canManage: true,
      canTrack: true,
      canChangeStatus: true,
      canEditFinished: true,
    });
  });

  it('stat tracker: track + status changes, no manage/delete', () => {
    expect(getGamePermissions(team, { id: 'scorer', role: 'PARENT' })).toEqual({
      canManage: false,
      canTrack: true,
      canChangeStatus: true,
      canEditFinished: false,
    });
  });

  it('team manager without canTrackStats can start/end but not track', () => {
    const p = getGamePermissions(team, { id: 'manager', role: 'COACH' });
    expect(p.canManage).toBe(true);
    expect(p.canChangeStatus).toBe(true);
    expect(p.canTrack).toBe(false);
  });

  it('a rostered player (not staff) gets nothing', () => {
    expect(getGamePermissions(team, { id: 'player', role: 'PLAYER' })).toEqual({
      canManage: false,
      canTrack: false,
      canChangeStatus: false,
      canEditFinished: false,
    });
  });

  it('system ADMIN and league admin of the team league get everything', () => {
    expect(getGamePermissions(team, { id: 'x', role: 'ADMIN' }).canManage).toBe(true);
    const leagueAdmin = { id: 'x', role: 'PLAYER', leagueAdminOf: ['league-1'] };
    expect(getGamePermissions(team, leagueAdmin)).toEqual({
      canManage: true,
      canTrack: true,
      canChangeStatus: true,
      canEditFinished: true,
    });
    const otherLeagueAdmin = { id: 'x', role: 'PLAYER', leagueAdminOf: ['league-2'] };
    expect(getGamePermissions(team, otherLeagueAdmin).canTrack).toBe(false);
  });

  it('a game payload whose team has no staff array denies non-admins', () => {
    expect(getGamePermissions({ staff: undefined }, { id: 'head', role: 'COACH' }).canManage).toBe(false);
    expect(getGamePermissions({ staff: undefined }, { id: 'head', role: 'ADMIN' }).canManage).toBe(true);
  });
});

describe('canManageAnyTeam', () => {
  const other = { staff: [staff('someone', { canManageTeam: true })] };

  it('true when the user manages at least one team', () => {
    expect(canManageAnyTeam([other, team], { id: 'manager', role: 'COACH' })).toBe(true);
    expect(canManageAnyTeam([other, team], { id: 'scorer', role: 'COACH' })).toBe(false);
  });

  it('false for no teams, empty lists and missing users', () => {
    expect(canManageAnyTeam(undefined, { id: 'head', role: 'COACH' })).toBe(false);
    expect(canManageAnyTeam([], { id: 'head', role: 'ADMIN' })).toBe(false);
    expect(canManageAnyTeam([team], null)).toBe(false);
  });

  it('league admins count for teams in their league only', () => {
    const la = { id: 'la', role: 'PLAYER', leagueAdminOf: ['league-1'] };
    expect(canManageAnyTeam([other], la)).toBe(false);
    expect(canManageAnyTeam([other, team], la)).toBe(true);
  });

  it('works on GET /teams LIST items — the payload the Games FAB actually gates on (#469)', () => {
    // The list payload carries the CALLER's own staff row only (backend
    // teamListInclude). Before #469 it carried no `staff` at all, which made
    // this gate false for every coach and hid game creation app-wide. This
    // test pins the contract from the consumer side: the list shape (with
    // `_count`, without `members`) must satisfy the gate when the caller's
    // row is present, and the pre-fix shape must fail it — if the backend
    // ever drops the caller-scoped staff join again, this documents what
    // breaks.
    const coach = { id: 'frank', role: 'COACH' };
    const listItem = {
      id: 't1',
      name: 'Lakers',
      season: { id: 's1', name: 'Spring', league: { id: 'league-1', name: 'Downtown' } },
      staff: [staff('frank', { canManageTeam: true, canManageRoster: true })],
      _count: { members: 12, staff: 1, games: 3 },
    };
    const preFixListItem = {
      id: 't1',
      name: 'Lakers',
      season: { id: 's1', name: 'Spring', league: { id: 'league-1', name: 'Downtown' } },
      _count: { members: 12, staff: 1, games: 3 },
    };

    expect(canManageAnyTeam([listItem], coach)).toBe(true);
    expect(canManageAnyTeam([preFixListItem], coach)).toBe(false);
    // A rostered player's list items carry an empty staff join — still gated.
    expect(canManageAnyTeam([{ ...listItem, staff: [] }], { id: 'steph', role: 'PLAYER' })).toBe(false);
  });
});
