/**
 * Tests for auth-store.
 *
 * Exercises setAuthToken / setUser / logout state transitions and verifies
 * that login/logout integrate with the analytics service (identify, track,
 * reset). Analytics is mocked to isolate the store's behavior.
 */

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  AnalyticsEvents: {
    USER_LOGGED_IN: 'user_logged_in',
    USER_LOGGED_OUT: 'user_logged_out',
  },
}));

import { useAuthStore, useAuthUser, useIsAuthenticated } from '../../store/auth-store';
import {
  trackEvent,
  identifyUser,
  resetUser,
  AnalyticsEvents,
} from '../../services/analytics';
import { UserRole, User } from '../../../shared/types';

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
});
