/**
 * Runtime tests for useInvitations hooks.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useInvitations,
  useInvitation,
  useTeamInvitations,
  usePlayerInvitations,
  useCreateInvitation,
  useAcceptInvitation,
  useRejectInvitation,
  useCancelInvitation,
  invitationKeys,
} from '../../hooks/useInvitations';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

describe('useInvitations runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches invitations with no params', async () => {
    const payload = {
      success: true,
      invitations: [],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    };
    mockedGet.mockResolvedValueOnce({ data: payload });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitations(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
    expect(mockedGet).toHaveBeenCalledWith('/invitations', { params: undefined });
  });

  it('passes query params through to apiClient', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        success: true,
        invitations: [],
        pagination: { total: 0, limit: 0, offset: 0, hasMore: false },
      },
    });
    const { wrapper } = createQueryWrapper();
    const params = { status: 'PENDING' as const, teamId: 't1' };
    const { result } = renderHook(() => useInvitations(params), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedGet).toHaveBeenCalledWith('/invitations', { params });
  });

  it('fetches a single invitation by id', async () => {
    const response = { success: true, invitation: { id: 'inv-1' } };
    mockedGet.mockResolvedValueOnce({ data: response });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitation('inv-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(mockedGet).toHaveBeenCalledWith('/invitations/inv-1');
  });

  it('useInvitation is disabled without an id', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitation(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('useTeamInvitations forwards teamId + status to useInvitations', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        success: true,
        invitations: [],
        pagination: { total: 0, limit: 0, offset: 0, hasMore: false },
      },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTeamInvitations('t1', 'PENDING'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedGet).toHaveBeenCalledWith('/invitations', {
      params: { teamId: 't1', status: 'PENDING' },
    });
  });

  it('usePlayerInvitations forwards only status', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        success: true,
        invitations: [],
        pagination: { total: 0, limit: 0, offset: 0, hasMore: false },
      },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerInvitations('ACCEPTED'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedGet).toHaveBeenCalledWith('/invitations', {
      params: { status: 'ACCEPTED' },
    });
  });

  it('useCreateInvitation posts and invalidates list + team caches', async () => {
    const response = { success: true, invitation: { id: 'inv-1' } };
    mockedPost.mockResolvedValueOnce({ data: response });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateInvitation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        teamId: 't1',
        data: { playerId: 'p1' },
      });
    });

    expect(mockedPost).toHaveBeenCalledWith('/teams/t1/invitations', {
      playerId: 'p1',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: invitationKeys.lists(),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: invitationKeys.team('t1'),
    });
  });

  it('useAcceptInvitation invalidates all invitations and teams when teamMember present', async () => {
    const response = {
      success: true,
      invitation: { id: 'inv-1' },
      teamMember: { id: 'tm-1', teamId: 't1', playerId: 'p1' },
    };
    mockedPost.mockResolvedValueOnce({ data: response });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAcceptInvitation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('inv-1');
    });

    expect(mockedPost).toHaveBeenCalledWith('/invitations/inv-1/accept');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: invitationKeys.all,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['teams'] });
  });

  it('useAcceptInvitation does not invalidate teams when teamMember absent', async () => {
    const response = { success: true, invitation: { id: 'inv-1' } };
    mockedPost.mockResolvedValueOnce({ data: response });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAcceptInvitation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('inv-1');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: invitationKeys.all,
    });
    expect(
      invalidateSpy.mock.calls.some(
        (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(['teams'])
      )
    ).toBe(false);
  });

  it('useRejectInvitation posts and invalidates all invitations', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { success: true, invitation: { id: 'inv-1' } },
    });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRejectInvitation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('inv-1');
    });

    expect(mockedPost).toHaveBeenCalledWith('/invitations/inv-1/reject');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: invitationKeys.all,
    });
  });

  it('useCancelInvitation deletes and invalidates all invitations', async () => {
    mockedDelete.mockResolvedValueOnce({
      data: { success: true, invitation: { id: 'inv-1' } },
    });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCancelInvitation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('inv-1');
    });

    expect(mockedDelete).toHaveBeenCalledWith('/invitations/inv-1');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: invitationKeys.all,
    });
  });
});
