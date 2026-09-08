/**
 * Runtime tests for hooks/useAccount.ts (#444 account deletion).
 *
 * The mocked api-client proves endpoint shapes and, more importantly, the
 * side effects: self-deletion clears the LOCAL session only (no remote
 * logout — the server side is already gone), and a child-record deletion
 * re-reads GET /auth/me so "My kids" drops the child immediately.
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { AxiosError, AxiosHeaders } from 'axios';
import { useDeleteAccount, useDeleteChildRecord, getLastHeadCoachTeams } from '../../hooks/useAccount';
import { apiClient, normalizeApiError } from '../../services/api-client';
import { useAuthStore } from '../../store/auth-store';
import { createQueryWrapper } from '../utils/queryWrapper';

// The global mock (jest.setup.js) exposes only `apiClient`; the error helpers
// under test are the real ones.
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

function apiError(status: number, body: Record<string, unknown>): AxiosError {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: 'x',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: body,
  });
  return normalizeApiError(error) as AxiosError;
}

describe('useAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      user: { id: 'me', role: 'COACH', email: 'me@example.com', name: 'Me', guardianOf: [] } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: 'r',
      isLoading: false,
    });
  });

  it('useDeleteAccount calls DELETE /auth/me and clears the local session on success', async () => {
    mockedDelete.mockResolvedValue({ data: { success: true, identityDeleted: true } });
    const clearSession = jest.spyOn(useAuthStore.getState(), 'clearSession');

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: createQueryWrapper().wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(mockedDelete).toHaveBeenCalledWith('/auth/me');
    await waitFor(() => expect(clearSession).toHaveBeenCalledTimes(1));
    clearSession.mockRestore();
  });

  it('useDeleteAccount leaves the session alone when the request fails', async () => {
    mockedDelete.mockRejectedValue(apiError(400, { error: 'nope', code: 'last_head_coach', teams: [] }));
    const clearSession = jest.spyOn(useAuthStore.getState(), 'clearSession');

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: createQueryWrapper().wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toBeDefined();
    });

    expect(clearSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    clearSession.mockRestore();
  });

  it('useDeleteChildRecord calls DELETE /players/:id/account then re-reads /auth/me into the store', async () => {
    useAuthStore.getState().updateUser({
      guardianOf: [{ childId: 'kid', childName: 'Kid', relationship: 'MOTHER', isPrimary: true, isManaged: true }],
    });
    mockedDelete.mockResolvedValue({ data: { success: true } });
    mockedGet.mockResolvedValue({ data: { success: true, user: { role: 'PARENT', guardianOf: [] } } });

    const { result } = renderHook(() => useDeleteChildRecord(), { wrapper: createQueryWrapper().wrapper });
    await act(async () => {
      await result.current.mutateAsync({ childId: 'kid' });
    });

    expect(mockedDelete).toHaveBeenCalledWith('/players/kid/account');
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/auth/me'));
    await waitFor(() => expect(useAuthStore.getState().user?.guardianOf).toEqual([]));
  });

  it('useDeleteChildRecord still resolves when the /auth/me re-read fails (best-effort)', async () => {
    mockedDelete.mockResolvedValue({ data: { success: true } });
    mockedGet.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useDeleteChildRecord(), { wrapper: createQueryWrapper().wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ childId: 'kid' })).resolves.toBeUndefined();
    });
  });

  describe('getLastHeadCoachTeams', () => {
    it('extracts the team list from a 400 last_head_coach body', () => {
      const error = apiError(400, {
        error: 'You are the only Head Coach…',
        code: 'last_head_coach',
        teams: [{ id: 't1', name: 'Lakers' }, { id: 't2', name: 'Bulls' }],
      });
      expect(getLastHeadCoachTeams(error)).toEqual([
        { id: 't1', name: 'Lakers' },
        { id: 't2', name: 'Bulls' },
      ]);
    });

    it('returns null for any other error', () => {
      expect(getLastHeadCoachTeams(apiError(500, { error: 'boom' }))).toBeNull();
      expect(getLastHeadCoachTeams(apiError(400, { error: 'bad', code: 'other' }))).toBeNull();
      expect(getLastHeadCoachTeams(new Error('network'))).toBeNull();
    });
  });
});
