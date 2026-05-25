/**
 * Runtime tests for useInvitationByToken hooks (public invite accept flow).
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useInvitationByToken,
  useAcceptInvitationByToken,
} from '../../hooks/useInvitationByToken';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;

const pendingInvitation = {
  id: 'inv-1',
  status: 'PENDING' as const,
  teamName: 'Lakers',
  inviterName: 'Coach Phil',
  position: 'PG',
  jerseyNumber: 23,
  message: null,
  expiresAt: '2026-07-01T00:00:00.000Z',
};

describe('useInvitationByToken runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches invitation by token from the public endpoint', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, invitation: pendingInvitation },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitationByToken('tok-abc'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(pendingInvitation);
    expect(mockedGet).toHaveBeenCalledWith('/invitations/by-token/tok-abc');
  });

  it('is disabled (idle) when token is undefined', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitationByToken(undefined), {
      wrapper,
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('is disabled (idle) when token is an empty string', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitationByToken(''), {
      wrapper,
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('surfaces API error and does not retry', async () => {
    mockedGet.mockRejectedValueOnce(new Error('not found'));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitationByToken('bad-token'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('returns expired invitation as data (not as error) so the UI can render the state', async () => {
    const expired = { ...pendingInvitation, status: 'EXPIRED' as const };
    mockedGet.mockResolvedValueOnce({
      data: { success: true, invitation: expired },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useInvitationByToken('tok-exp'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe('EXPIRED');
  });
});

describe('useAcceptInvitationByToken runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts to the by-token accept endpoint', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { success: true, message: 'Welcome to Lakers' },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useAcceptInvitationByToken(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync('tok-abc');
    });

    expect(mockedPost).toHaveBeenCalledWith('/invitations/by-token/tok-abc/accept');
  });

  it('invalidates both the by-token and the invitations list caches on success', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { success: true, message: 'Welcome' },
    });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAcceptInvitationByToken(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync('tok-abc');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['invitationByToken', 'tok-abc'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['invitations'] });
  });

  it('propagates accept failures to the caller', async () => {
    mockedPost.mockRejectedValueOnce(new Error('expired token'));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useAcceptInvitationByToken(), {
      wrapper,
    });

    await expect(
      act(async () => {
        await result.current.mutateAsync('bad-token');
      })
    ).rejects.toThrow('expired token');
  });
});
