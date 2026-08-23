/**
 * Tests for useAuthRedirect: the app must route to /login when an
 * authenticated session is lost mid-app (regression for #349, where an
 * expired token left the user stranded on a tab with every request failing).
 */

import { renderHook, act } from '@testing-library/react-native';
import { useAuthRedirect } from '../../hooks/useAuthRedirect';
import { useAuthStore } from '../../store/auth-store';
import { setSessionHooks } from '../../store/session-hooks';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  AnalyticsEvents: { USER_LOGGED_IN: 'in', USER_LOGGED_OUT: 'out' },
}));

describe('useAuthRedirect', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    setSessionHooks({ remoteLogout: () => Promise.resolve(), localCleanup: () => undefined });
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null, isAuthenticated: false, isLoading: false });
  });

  it('does not redirect on mount when already unauthenticated (index.tsx owns cold-start routing)', () => {
    renderHook(() => useAuthRedirect());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not redirect on mount or on login when authenticated', () => {
    useAuthStore.setState({ accessToken: 't', isAuthenticated: true });
    renderHook(() => useAuthRedirect());
    act(() => useAuthStore.getState().setAuthToken('t2', 'r2'));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects to /login when the session is lost', () => {
    useAuthStore.setState({ accessToken: 't', isAuthenticated: true });
    renderHook(() => useAuthRedirect());

    act(() => useAuthStore.getState().clearSession());

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  it('redirects to /login after a user-initiated logout', async () => {
    useAuthStore.setState({ accessToken: 't', isAuthenticated: true });
    renderHook(() => useAuthRedirect());

    await act(async () => {
      await useAuthStore.getState().logout();
    });

    expect(mockReplace).toHaveBeenCalledWith('/login');
  });
});
