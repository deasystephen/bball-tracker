/**
 * Runtime tests for hooks/useGuardians.ts (PARENT role — player guardians).
 *
 * Exercises the React Query hooks against the mocked api-client: endpoint
 * shapes, response unwrapping and cache invalidation (guardian list + team
 * detail, plus invitations after an invite).
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  usePlayerGuardians,
  useInviteGuardian,
  useRemoveGuardian,
  guardianKeys,
  type GuardianRow,
  type PendingGuardianInvitation,
} from '../../hooks/useGuardians';
import { teamKeys } from '../../hooks/useTeams';
import { invitationKeys } from '../../hooks/useInvitations';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

const row: GuardianRow = {
  id: 'g1',
  userId: 'dell',
  name: 'Dell Curry',
  email: 'dell.curry@example.com',
  relationship: 'FATHER',
  isPrimary: true,
  createdAt: '2026-08-01T00:00:00Z',
};

const pending: PendingGuardianInvitation = {
  id: 'gi1',
  childId: 'steph',
  teamId: 't1',
  invitedEmail: 'sonya.curry@example.com',
  relationship: 'MOTHER',
  invitedById: 'coach-1',
  status: 'PENDING',
  expiresAt: '2026-09-01T00:00:00Z',
  createdAt: '2026-08-20T00:00:00Z',
  updatedAt: '2026-08-20T00:00:00Z',
};

describe('useGuardians runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('usePlayerGuardians fetches GET /teams/:id/members/:playerId/guardians', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, guardians: [row], pendingInvitations: [pending] },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerGuardians('t1', 'steph'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ guardians: [row], pendingInvitations: [pending] });
    expect(mockedGet).toHaveBeenCalledWith('/teams/t1/members/steph/guardians');
  });

  it('usePlayerGuardians defaults missing arrays to []', async () => {
    mockedGet.mockResolvedValueOnce({ data: { success: true } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerGuardians('t1', 'steph'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ guardians: [], pendingInvitations: [] });
  });

  it('usePlayerGuardians is disabled without ids', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerGuardians('', 'steph'), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('useInviteGuardian POSTs { email, relationship } and invalidates guardians, team and invitations', async () => {
    mockedPost.mockResolvedValueOnce({ data: { success: true, invitation: pending } });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useInviteGuardian(), { wrapper });

    let returned: PendingGuardianInvitation | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync({
        teamId: 't1',
        playerId: 'steph',
        data: { email: 'sonya.curry@example.com', relationship: 'MOTHER' },
      });
    });

    expect(returned).toEqual(pending);
    expect(mockedPost).toHaveBeenCalledWith('/teams/t1/members/steph/guardians', {
      email: 'sonya.curry@example.com',
      relationship: 'MOTHER',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: guardianKeys.player('t1', 'steph') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: invitationKeys.all });
  });

  it('useInviteGuardian surfaces API errors', async () => {
    mockedPost.mockRejectedValueOnce(new Error('Already a guardian'));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInviteGuardian(), { wrapper });

    await expect(
      result.current.mutateAsync({
        teamId: 't1',
        playerId: 'steph',
        data: { email: 'dell.curry@example.com', relationship: 'FATHER' },
      })
    ).rejects.toThrow('Already a guardian');
  });

  it('useRemoveGuardian DELETEs the guardian and invalidates guardians + team detail', async () => {
    mockedDelete.mockResolvedValueOnce({ data: { success: true } });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveGuardian(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ teamId: 't1', playerId: 'steph', guardianUserId: 'dell' });
    });

    expect(mockedDelete).toHaveBeenCalledWith('/teams/t1/members/steph/guardians/dell');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: guardianKeys.player('t1', 'steph') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
  });
});
