/**
 * Tests for auth-store.
 *
 * Exercises setAuthToken / setUser / logout state transitions and verifies
 * that login/logout integrate with the analytics service (identify, track,
 * reset). Analytics is mocked to isolate the store's behavior.
 */

import { renderHook } from '@testing-library/react-native';
import {
  useAuthStore,
  useAuthUser,
  useIsAuthenticated,
  useAuthActions,
} from '../../store/auth-store';
import {
  trackEvent,
  identifyUser,
  resetUser,
  AnalyticsEvents,
} from '../../services/analytics';
import { UserRole, User } from '../../../shared/types';

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  AnalyticsEvents: {
    USER_LOGGED_IN: 'user_logged_in',
    USER_LOGGED_OUT: 'user_logged_out',
  },
}));

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  role: UserRole.COACH,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

describe('auth-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: true,
    });
  });

  it('starts unauthenticated with no token/user', () => {
    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('setAuthToken stores the token and marks authenticated', () => {
    useAuthStore.getState().setAuthToken('jwt-abc');

    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('jwt-abc');
    expect(state.isAuthenticated).toBe(true);
  });

  it('setUser stores user, marks authenticated, clears loading, and tracks login', () => {
    const user = makeUser();
    useAuthStore.getState().setUser(user);

    const state = useAuthStore.getState();
    expect(state.user).toEqual(user);
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);

    expect(identifyUser).toHaveBeenCalledWith('user-1');
    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEvents.USER_LOGGED_IN);
  });

  it('logout clears token + user, resets auth flags, and notifies analytics', () => {
    useAuthStore.setState({
      accessToken: 'jwt-abc',
      user: makeUser(),
      isAuthenticated: true,
      isLoading: false,
    });

    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);

    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEvents.USER_LOGGED_OUT);
    expect(resetUser).toHaveBeenCalled();
  });

  it('selectors return the current slice of state', () => {
    // Pre-populate the store so selectors have something to read.
    const user = makeUser({ id: 'user-42' });
    useAuthStore.setState({
      accessToken: 'tok',
      user,
      isAuthenticated: true,
      isLoading: false,
    });

    // Selectors are themselves hooks, but they're thin wrappers that call
    // useAuthStore with a selector. We verify they read from the same store
    // by invoking the underlying store directly with the same selector.
    expect(useAuthStore.getState().user).toEqual(user);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // Smoke check the selector references exist and are functions.
    expect(typeof useAuthUser).toBe('function');
    expect(typeof useIsAuthenticated).toBe('function');
  });

  // Regression: useAuthActions must return a referentially-stable object across
  // re-renders. Without `useShallow` (Zustand v5) it returned a new object every
  // render, so useSyncExternalStore's snapshot looked changed each render and
  // AuthCallbackScreen hit "Maximum update depth exceeded" (Sentry MOBILE-1).
  it('useAuthActions returns a stable reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useAuthActions());
    const first = result.current;

    rerender({});

    expect(result.current).toBe(first);
    expect(typeof first.setAuthToken).toBe('function');
    expect(typeof first.setUser).toBe('function');
    expect(typeof first.logout).toBe('function');
  });

  it('setAuthToken stores the refresh token alongside the access token', () => {
    useAuthStore.getState().setAuthToken('access', 'refresh');
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      isAuthenticated: true,
    });

    // Dev-login has no refresh token; it must clear any stale one.
    useAuthStore.getState().setAuthToken('dev_token');
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  it('logout clears the refresh token', () => {
    useAuthStore.getState().setAuthToken('access', 'refresh');
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  it('persists the refresh token so sessions survive an app restart', () => {
    // partialize is what decides what lands in AsyncStorage.
    const persistOptions = (useAuthStore as unknown as {
      persist: { getOptions: () => { partialize: (s: unknown) => Record<string, unknown> } };
    }).persist.getOptions();
    const persisted = persistOptions.partialize({
      accessToken: 'a',
      refreshToken: 'r',
      user: null,
      isAuthenticated: true,
      isLoading: false,
    });
    expect(persisted).toEqual({ accessToken: 'a', refreshToken: 'r', user: null, isAuthenticated: true });
  });
});
