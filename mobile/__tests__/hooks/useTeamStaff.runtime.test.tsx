/**
 * Runtime tests for hooks/useTeamStaff.ts (team staff management, B2.3).
 *
 * Exercises the React Query hooks against the mocked api-client: endpoint
 * shapes, response unwrapping and cache invalidation (staff list, team
 * detail + lists, and the usage meter — staff rows feed the FREE-tier cap).
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useTeamStaff,
  useTeamRoles,
  useAddStaff,
  useUpdateStaffRole,
  useRemoveStaff,
  teamStaffKeys,
  type TeamStaffRow,
  type TeamRole,
} from '../../hooks/useTeamStaff';
import { teamKeys } from '../../hooks/useTeams';
import { usageKeys } from '../../hooks/useUsage';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

const headCoachRole: TeamRole = {
  id: 'r-head',
  teamId: 't1',
  type: 'HEAD_COACH',
  name: 'Head Coach',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

const row: TeamStaffRow = {
  id: 'ts1',
  teamId: 't1',
  userId: 'coach-1',
  roleId: 'r-head',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  user: { id: 'coach-1', name: 'Frank', email: 'frank@example.com' },
  role: headCoachRole,
};

const expectStaffInvalidation = (invalidateSpy: jest.SpyInstance, teamId: string) => {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamStaffKeys.list(teamId) });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail(teamId) });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: usageKeys.all });
};

describe('useTeamStaff runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('queries', () => {
    it('useTeamStaff fetches GET /teams/:id/staff and unwraps `staff`', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true, staff: [row] } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeamStaff('t1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([row]);
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/staff');
    });

    it('useTeamStaff returns [] when the payload has no staff array', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeamStaff('t1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([]);
    });

    it('useTeamStaff is disabled without a teamId', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeamStaff(''), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('useTeamRoles fetches GET /teams/:id/roles and unwraps `roles`', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true, roles: [headCoachRole] } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useTeamRoles('t1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([headCoachRole]);
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/roles');
    });
  });

  describe('mutations', () => {
    it('useAddStaff posts by email and invalidates staff, team detail/lists and usage', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true, staff: row } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useAddStaff(), { wrapper });

      let returned: TeamStaffRow | undefined;
      await act(async () => {
        returned = await result.current.mutateAsync({
          teamId: 't1',
          data: { email: 'frank@example.com', roleType: 'ASSISTANT_COACH' },
        });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/staff', {
        email: 'frank@example.com',
        roleType: 'ASSISTANT_COACH',
      });
      expect(returned).toEqual(row);
      expectStaffInvalidation(invalidateSpy, 't1');
    });

    it('useAddStaff posts by userId', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true, staff: row } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useAddStaff(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', data: { userId: 'u2', roleType: 'TEAM_MANAGER' } });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/staff', { userId: 'u2', roleType: 'TEAM_MANAGER' });
    });

    it('useAddStaff surfaces a 404 (no account for that email) and does not invalidate', async () => {
      const notFound = Object.assign(new Error('User not found'), {
        apiError: { status: 404, error: 'User not found' },
      });
      mockedPost.mockRejectedValueOnce(notFound);
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useAddStaff(), { wrapper });

      await act(async () => {
        await expect(
          result.current.mutateAsync({ teamId: 't1', data: { email: 'nobody@x.y', roleType: 'HEAD_COACH' } })
        ).rejects.toBe(notFound);
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('useUpdateStaffRole patches /staff/:userId and invalidates', async () => {
      mockedPatch.mockResolvedValueOnce({ data: { success: true, staff: row } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useUpdateStaffRole(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', userId: 'coach-1', roleType: 'HEAD_COACH' });
      });

      expect(mockedPatch).toHaveBeenCalledWith('/teams/t1/staff/coach-1', { roleType: 'HEAD_COACH' });
      expectStaffInvalidation(invalidateSpy, 't1');
    });

    it('useRemoveStaff deletes /staff/:userId and invalidates', async () => {
      mockedDelete.mockResolvedValueOnce({ data: { success: true } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useRemoveStaff(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', userId: 'coach-1' });
      });

      expect(mockedDelete).toHaveBeenCalledWith('/teams/t1/staff/coach-1');
      expectStaffInvalidation(invalidateSpy, 't1');
    });
  });
});
