/**
 * Runtime tests for useTeams hooks + permission helpers.
 *
 * Exercises the React Query hook execution (query string serialization,
 * endpoint calls, cache invalidation) and the pure permission helpers
 * (hasTeamPermission / isHeadCoach / getUserTeamRole).
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useTeams,
  useTeam,
  useCreateTeam,
  useUpdateTeam,
  useDeleteTeam,
  useAddRosterPlayer,
  useRemovePlayerFromTeam,
  hasTeamPermission,
  isHeadCoach,
  getUserTeamRole,
  teamKeys,
  type Team,
} from '../../hooks/useTeams';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

const headCoachRole = {
  id: 'r1',
  name: 'Head Coach',
  type: 'HEAD_COACH' as const,
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: false,
};

const team: Team = {
  id: 't1',
  name: 'Hawks',
  seasonId: 's1',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  staff: [
    {
      id: 'staff1',
      userId: 'coach-1',
      user: { id: 'coach-1', name: 'Coach', email: 'c@test.com' },
      role: headCoachRole,
    },
  ],
};

describe('useTeams runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('useTeams query', () => {
    it('fetches teams and returns the list', async () => {
      mockedGet.mockResolvedValueOnce({ data: { teams: [team] } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeams(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([team]);
      expect(mockedGet).toHaveBeenCalledWith('/teams?');
    });

    it('serializes filters into the query string', async () => {
      mockedGet.mockResolvedValueOnce({ data: { teams: [] } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () => useTeams({ seasonId: 's1', leagueId: 'l1', playerId: 'p1', limit: 5, offset: 10 }),
        { wrapper }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = mockedGet.mock.calls[0][0] as string;
      expect(url).toContain('seasonId=s1');
      expect(url).toContain('leagueId=l1');
      expect(url).toContain('playerId=p1');
      expect(url).toContain('limit=5');
      expect(url).toContain('offset=10');
    });
  });

  describe('useTeam query', () => {
    it('fetches a single team by id', async () => {
      mockedGet.mockResolvedValueOnce({ data: { team } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeam('t1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(team);
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1');
    });

    it('is disabled when teamId is empty', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeam(''), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });
  });

  describe('mutations', () => {
    it('useCreateTeam posts and invalidates the list', async () => {
      mockedPost.mockResolvedValueOnce({ data: { team } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useCreateTeam(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ name: 'Hawks', seasonId: 's1' });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams', { name: 'Hawks', seasonId: 's1' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
    });

    it('useUpdateTeam patches and invalidates list + detail', async () => {
      mockedPatch.mockResolvedValueOnce({ data: { team } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useUpdateTeam(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', data: { name: 'New' } });
      });

      expect(mockedPatch).toHaveBeenCalledWith('/teams/t1', { name: 'New' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
    });

    it('useDeleteTeam deletes and invalidates the list', async () => {
      mockedDelete.mockResolvedValueOnce({ data: {} });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useDeleteTeam(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync('t1');
      });

      expect(mockedDelete).toHaveBeenCalledWith('/teams/t1');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
    });

    it('useAddRosterPlayer posts the unified payload and invalidates team + invitations', async () => {
      mockedPost.mockResolvedValueOnce({
        data: {
          success: true,
          rostered: true,
          invited: true,
          member: { id: 'm1', playerId: 'p1', player: { id: 'p1', name: 'Jane', isManaged: true } },
          invitation: { id: 'inv1' },
          guardianInvited: false,
          emails: { player: true },
        },
      });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useAddRosterPlayer(), { wrapper });

      let response;
      await act(async () => {
        response = await result.current.mutateAsync({
          teamId: 't1',
          data: { name: 'Jane', playerEmail: 'jane@example.com' },
        });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/players', {
        name: 'Jane',
        playerEmail: 'jane@example.com',
      });
      expect(response).toMatchObject({ rostered: true, emails: { player: true } });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['invitations'] });
      // An email was sent, so the player-search cache refreshes too
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['players'] });
    });

    it('useAddRosterPlayer skips invitation/player invalidation for a name-only add', async () => {
      mockedPost.mockResolvedValueOnce({
        data: {
          success: true,
          rostered: true,
          invited: false,
          member: { id: 'm1', playerId: 'p1', player: { id: 'p1', name: 'Kid', isManaged: true } },
          invitation: null,
          guardianInvited: false,
          emails: {},
        },
      });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useAddRosterPlayer(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', data: { name: 'Kid' } });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['invitations'] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['players'] });
    });

    it('useAddRosterPlayer surfaces the case-3 not-rostered response', async () => {
      mockedPost.mockResolvedValueOnce({
        data: {
          success: true,
          rostered: false,
          invited: true,
          member: null,
          invitation: { id: 'inv1' },
          guardianInvited: false,
          guardianReason: 'Guardians can be added after the player accepts the invitation',
          emails: { player: true },
        },
      });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useAddRosterPlayer(), { wrapper });

      let response;
      await act(async () => {
        response = await result.current.mutateAsync({
          teamId: 't1',
          data: { name: 'Jane', playerEmail: 'existing@example.com', guardianEmail: 'mom@example.com', guardianRelationship: 'MOTHER' },
        });
      });

      expect(response).toMatchObject({ rostered: false, member: null, guardianInvited: false });
    });

    it('useRemovePlayerFromTeam deletes and invalidates the team detail', async () => {
      mockedDelete.mockResolvedValueOnce({ data: {} });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useRemovePlayerFromTeam(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', playerId: 'p1' });
      });

      expect(mockedDelete).toHaveBeenCalledWith('/teams/t1/players/p1');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
    });
  });

  describe('permission helpers', () => {
    it('hasTeamPermission returns the role flag for a staff member', () => {
      expect(hasTeamPermission(team, 'coach-1', 'canManageTeam')).toBe(true);
      expect(hasTeamPermission(team, 'coach-1', 'canShareStats')).toBe(false);
    });

    it('hasTeamPermission returns false for missing team / user / staff', () => {
      expect(hasTeamPermission(undefined, 'coach-1', 'canManageTeam')).toBe(false);
      expect(hasTeamPermission(team, undefined, 'canManageTeam')).toBe(false);
      expect(hasTeamPermission(team, 'stranger', 'canManageTeam')).toBe(false);
    });

    it('isHeadCoach detects the head coach and rejects others', () => {
      expect(isHeadCoach(team, 'coach-1')).toBe(true);
      expect(isHeadCoach(team, 'stranger')).toBe(false);
      expect(isHeadCoach(undefined, 'coach-1')).toBe(false);
      expect(isHeadCoach(team, undefined)).toBe(false);
    });

    it('getUserTeamRole returns the role or null', () => {
      expect(getUserTeamRole(team, 'coach-1')).toEqual(headCoachRole);
      expect(getUserTeamRole(team, 'stranger')).toBeNull();
      expect(getUserTeamRole(undefined, 'coach-1')).toBeNull();
      expect(getUserTeamRole(team, undefined)).toBeNull();
    });
  });
});
