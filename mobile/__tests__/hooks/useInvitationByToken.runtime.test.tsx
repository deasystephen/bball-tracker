/**
 * Runtime tests for useInvitationByToken (public invite lookup).
 */

import { renderHook, waitFor } from '@testing-library/react-native';

import { useInvitationByToken } from '../../hooks/useInvitationByToken';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;

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
