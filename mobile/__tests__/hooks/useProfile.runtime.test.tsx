/**
 * Runtime tests for useUpdateProfile (PATCH /auth/me).
 *
 * Regression for audit #10: the Profile tab must not go through
 * PATCH /players/:id (404 for ADMIN/COACH); it must hit /auth/me and merge the
 * returned user into the auth store without re-firing login analytics.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import { useUpdateProfile, toUserPatch } from '../../hooks/useProfile';
import { apiClient } from '../../services/api-client';
import { useAuthStore } from '../../store/auth-store';
import { UserRole } from '../../../shared/types';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedPatch = apiClient.patch as jest.Mock;

const storedUser = {
  id: 'u1',
  email: 'coach@test.com',
  name: 'Old Name',
  role: UserRole.COACH,
  profilePictureUrl: 'https://cdn.test/old.jpg',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

describe('useUpdateProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ user: storedUser, isAuthenticated: true, isLoading: false });
  });

  it('PATCHes /auth/me (not /players/:id) and merges the avatar into the auth store', async () => {
    mockedPatch.mockResolvedValueOnce({
      data: {
        success: true,
        user: { ...storedUser, profilePictureUrl: 'https://cdn.test/new.jpg', createdAt: '2026-01-01' },
      },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ profilePictureUrl: 'https://cdn.test/new.jpg' });
    });

    expect(mockedPatch).toHaveBeenCalledWith('/auth/me', { profilePictureUrl: 'https://cdn.test/new.jpg' });
    await waitFor(() =>
      expect(useAuthStore.getState().user?.profilePictureUrl).toBe('https://cdn.test/new.jpg')
    );
    // Other fields survive the merge
    expect(useAuthStore.getState().user?.role).toBe('COACH');
    expect(useAuthStore.getState().user?.email).toBe('coach@test.com');
  });

  it('clears the avatar when the API returns null', async () => {
    mockedPatch.mockResolvedValueOnce({
      data: { success: true, user: { ...storedUser, profilePictureUrl: null, createdAt: '2026-01-01' } },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ profilePictureUrl: '' });
    });

    expect(mockedPatch).toHaveBeenCalledWith('/auth/me', { profilePictureUrl: '' });
    await waitFor(() => expect(useAuthStore.getState().user?.profilePictureUrl).toBeUndefined());
  });

  it('surfaces API errors and leaves the store untouched', async () => {
    mockedPatch.mockRejectedValueOnce(new Error('Network error'));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useUpdateProfile(), { wrapper });

    await expect(
      act(async () => {
        await result.current.mutateAsync({ name: 'New' });
      })
    ).rejects.toThrow('Network error');

    expect(useAuthStore.getState().user?.name).toBe('Old Name');
  });
});

describe('toUserPatch', () => {
  it('maps a null avatar to undefined for the store', () => {
    expect(
      toUserPatch({ id: 'u1', email: null, name: 'N', role: UserRole.PLAYER, profilePictureUrl: null, createdAt: 'x' })
    ).toEqual({ name: 'N', profilePictureUrl: undefined });
  });
});
