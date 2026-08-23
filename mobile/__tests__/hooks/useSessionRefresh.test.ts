/**
 * useSessionRefresh — re-syncs role / leagueAdminOf / name / avatar from
 * GET /auth/me when the app foregrounds, throttled to once per 5 minutes.
 */

import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useSessionRefresh, SESSION_REFRESH_INTERVAL_MS } from '../../hooks/useSessionRefresh';
import { useAuthStore } from '../../store/auth-store';
import { apiClient } from '../../services/api-client';
import { UserRole } from '../../../shared/types';

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  AnalyticsEvents: { USER_LOGGED_IN: 'in', USER_LOGGED_OUT: 'out' },
}));

const mockGet = apiClient.get as jest.Mock;

type Listener = (state: string) => void;
let listeners: Listener[] = [];
const fireAppState = async (state: string): Promise<void> => {
  await act(async () => {
    listeners.forEach((l) => l(state));
  });
};

const baseUser = {
  id: 'u1',
  email: 'a@b.c',
  name: 'Old Name',
  role: UserRole.PLAYER,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('useSessionRefresh', () => {
  let removeSpy: jest.Mock;

  beforeEach(() => {
    // jest-expo ships AppState.addEventListener as a jest.fn; spyOn reuses
    // it, so call counts survive restoreAllMocks — clear them explicitly.
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T00:00:00Z'));
    listeners = [];
    removeSpy = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listeners.push(handler as Listener);
      return { remove: removeSpy } as never;
    });
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    mockGet.mockReset();
    useAuthStore.setState({
      accessToken: 't',
      refreshToken: null,
      user: baseUser,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('syncs once on mount for an active session and merges the synced fields', async () => {
    mockGet.mockResolvedValue({
      data: {
        success: true,
        user: {
          id: 'u1',
          email: 'changed@should.be.ignored',
          name: 'New Name',
          role: 'COACH',
          leagueAdminOf: ['league-1'],
          guardianOf: [{ childId: 'c1', childName: 'Kid', relationship: 'MOTHER', isPrimary: true }],
          profilePictureUrl: 'https://img/x.png',
        },
      },
    });

    renderHook(() => useSessionRefresh());
    await act(async () => {});

    expect(mockGet).toHaveBeenCalledWith('/auth/me');
    const user = useAuthStore.getState().user;
    expect(user?.role).toBe('COACH');
    expect(user?.leagueAdminOf).toEqual(['league-1']);
    expect(user?.guardianOf).toEqual([
      { childId: 'c1', childName: 'Kid', relationship: 'MOTHER', isPrimary: true },
    ]);
    expect(user?.name).toBe('New Name');
    expect(user?.profilePictureUrl).toBe('https://img/x.png');
    // Only the synced fields are merged; identity fields stay as cached.
    expect(user?.email).toBe('a@b.c');
  });

  it('does nothing when signed out', async () => {
    useAuthStore.setState({ accessToken: null, user: null, isAuthenticated: false });
    renderHook(() => useSessionRefresh());
    await act(async () => {});
    expect(mockGet).not.toHaveBeenCalled();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it('throttles foreground re-syncs to once per interval', async () => {
    mockGet.mockResolvedValue({ data: { success: true, user: { role: 'PLAYER' } } });
    renderHook(() => useSessionRefresh());
    await act(async () => {});
    expect(mockGet).toHaveBeenCalledTimes(1);

    await fireAppState('active');
    expect(mockGet).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + SESSION_REFRESH_INTERVAL_MS + 1);
    await fireAppState('active');
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Going to the background never triggers a fetch.
    jest.setSystemTime(Date.now() + SESSION_REFRESH_INTERVAL_MS + 1);
    await fireAppState('background');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('ignores a failed fetch and keeps the cached user', async () => {
    mockGet.mockRejectedValue(new Error('network'));
    renderHook(() => useSessionRefresh());
    await act(async () => {});
    expect(useAuthStore.getState().user).toEqual(baseUser);
  });

  it('drops a response that resolves after logout', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    mockGet.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderHook(() => useSessionRefresh());
    await act(async () => {});

    act(() => useAuthStore.getState().clearSession());
    await act(async () => {
      resolve({ data: { success: true, user: { role: 'ADMIN' } } });
    });
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('removes the AppState listener on unmount', () => {
    mockGet.mockResolvedValue({ data: { success: true, user: {} } });
    const { unmount } = renderHook(() => useSessionRefresh());
    unmount();
    expect(removeSpy).toHaveBeenCalled();
  });
});
