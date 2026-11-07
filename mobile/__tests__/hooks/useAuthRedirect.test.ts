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
let mockPathname = '/(tabs)/home';
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => mockPathname,
}));

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  setUserProperties: jest.fn(),
  appVersion: () => 'test',
  AnalyticsEvents: { USER_LOGGED_IN: 'in', USER_LOGGED_OUT: 'out' },
}));

describe('useAuthRedirect', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPathname = '/(tabs)/home';
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

  describe('the age gate (#981)', () => {
    const unconfirmed = { id: 'u1', email: 'n@example.com', name: 'N', role: 'PLAYER' as const, ageConfirmed: false };

    it('replaces to the age screen when the stored user has not answered the age question', () => {
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: unconfirmed as never });
      renderHook(() => useAuthRedirect());
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/age');
    });

    it('leaves the sign-in paths to postLoginRoute, so the age screen is not mounted twice', () => {
      for (const path of ['/', '/login', '/auth/callback']) {
        mockPathname = path;
        useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: unconfirmed as never });
        renderHook(() => useAuthRedirect());
      }
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('does nothing while already on the age screen', () => {
      mockPathname = '/onboarding/age';
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: unconfirmed as never });
      renderHook(() => useAuthRedirect());
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('reacts when the flag arrives later (a /auth/me sync or a 403 folded into the store)', () => {
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: { ...unconfirmed, ageConfirmed: true } as never });
      renderHook(() => useAuthRedirect());
      expect(mockReplace).not.toHaveBeenCalled();
      act(() => useAuthStore.getState().updateUser({ ageConfirmed: false }));
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/age');
    });

    it('does not send an age-refused session to /login: the age screen explains and sends it on itself', () => {
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: unconfirmed as never });
      mockPathname = '/onboarding/age';
      renderHook(() => useAuthRedirect());
      act(() => useAuthStore.getState().clearSession('age_refused'));
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('still sends every other lost session to /login', () => {
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: { ...unconfirmed, ageConfirmed: true } as never });
      renderHook(() => useAuthRedirect());
      act(() => useAuthStore.getState().clearSession('session_expired'));
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });

    it('never redirects a signed-out or confirmed user to the age screen', () => {
      useAuthStore.setState({ accessToken: null, isAuthenticated: false, user: unconfirmed as never });
      renderHook(() => useAuthRedirect());
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true, user: { ...unconfirmed, ageConfirmed: true } as never });
      renderHook(() => useAuthRedirect());
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
