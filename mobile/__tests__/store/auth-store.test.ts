/**
 * Tests for auth-store.
 *
 * Exercises setAuthToken / setUser / logout state transitions and verifies
 * that login/logout integrate with the analytics service (identify, track,
 * reset). Analytics is mocked to isolate the store's behavior.
 */

import { renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import {
  useAuthStore,
  useAuthUser,
  useIsAuthenticated,
  useAuthActions,
  getLogoutEpoch,
  AUTH_STORAGE_KEY,
} from '../../store/auth-store';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, SecureStoreNative } from '../../services/secure-storage';
import { setSessionHooks } from '../../store/session-hooks';
import {
  trackEvent,
  identifyUser,
  resetUser,
  setUserProperties,
  AnalyticsEvents,
} from '../../services/analytics';
import { UserRole, User } from '../../../shared/types';

// In-memory ExpoSecureStore native mock from jest.setup.js.
const secureNative = requireOptionalNativeModule('ExpoSecureStore') as SecureStoreNative;
const keychainGet = (key: string) => secureNative.getValueWithKeyAsync(key, {});
// Let Zustand persist's async storage writes settle.
const flushPersist = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  setUserProperties: jest.fn(),
  appVersion: () => '1.5.0',
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

    // User properties (#616) ride on identify: role flags and app version, never name or email.
    expect(identifyUser).toHaveBeenCalledWith('user-1', {
      role: UserRole.COACH,
      is_parent: false,
      is_player: false,
      app_version: '1.5.0',
    });
    expect(JSON.stringify((identifyUser as jest.Mock).mock.calls)).not.toContain('test@example.com');
    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEvents.USER_LOGGED_IN);
  });

  it('logout clears token + user, resets auth flags, and notifies analytics', async () => {
    useAuthStore.setState({
      accessToken: 'jwt-abc',
      user: makeUser(),
      isAuthenticated: true,
      isLoading: false,
    });

    await useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);

    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEvents.USER_LOGGED_OUT, { reason: 'user' });
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

  it('logout clears the refresh token', async () => {
    useAuthStore.getState().setAuthToken('access', 'refresh');
    await useAuthStore.getState().logout();
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

  it('persists tokens to SecureStore and everything else to AsyncStorage (audit #52)', async () => {
    useAuthStore.getState().setAuthToken('jwt-access', 'jwt-refresh');
    useAuthStore.getState().setUser(makeUser());
    await flushPersist();

    expect(await keychainGet(ACCESS_TOKEN_KEY)).toBe('jwt-access');
    expect(await keychainGet(REFRESH_TOKEN_KEY)).toBe('jwt-refresh');
    const raw = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
    expect(raw).not.toContain('jwt-access');
    expect(raw).not.toContain('jwt-refresh');
    expect(JSON.parse(raw as string).state.user.id).toBe('user-1');
  });

  it('clearSession wipes the SecureStore tokens and the AsyncStorage blob', async () => {
    useAuthStore.getState().setAuthToken('jwt-access', 'jwt-refresh');
    await flushPersist();
    expect(await keychainGet(ACCESS_TOKEN_KEY)).toBe('jwt-access');

    useAuthStore.getState().clearSession();
    await flushPersist();

    expect(await keychainGet(ACCESS_TOKEN_KEY)).toBeNull();
    expect(await keychainGet(REFRESH_TOKEN_KEY)).toBeNull();
    const raw = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
    expect(raw === null || !JSON.parse(raw).state.accessToken).toBe(true);
  });
});

/**
 * Clean logout (audit #17, #18, #19, #41): remote steps run while the token
 * is still valid, local cleanup always runs, and the logout epoch advances so
 * an in-flight refresh cannot resurrect the session.
 */
describe('auth-store logout sequence', () => {
  const mockedRemote = jest.fn(() => Promise.resolve());
  const mockedLocal = jest.fn();
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    jest.clearAllMocks();
    setSessionHooks({ remoteLogout: mockedRemote, localCleanup: mockedLocal });
    useAuthStore.setState({ accessToken: 'a', refreshToken: 'r', user: makeUser(), isAuthenticated: true, isLoading: false });
  });

  it('runs the remote steps with the token still in the store, then clears locally', async () => {
    let tokenDuringRemote: string | null = 'unset';
    mockedRemote.mockImplementationOnce(async () => {
      tokenDuringRemote = useAuthStore.getState().accessToken;
    });

    await useAuthStore.getState().logout();
    await flush();

    expect(tokenDuringRemote).toBe('a');
    expect(mockedRemote).toHaveBeenCalledTimes(1);
    expect(mockedLocal).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, user: null, isAuthenticated: false });
    expect(resetUser).toHaveBeenCalled();
  });

  it('still signs out locally when the remote steps fail', async () => {
    mockedRemote.mockRejectedValueOnce(new Error('offline'));

    await useAuthStore.getState().logout();
    await flush();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockedLocal).toHaveBeenCalledTimes(1);
  });

  it('skips the remote steps when there is no access token', async () => {
    useAuthStore.setState({ accessToken: null, isAuthenticated: false });
    await useAuthStore.getState().logout();
    expect(mockedRemote).not.toHaveBeenCalled();
  });

  it('advances the logout epoch before the remote steps run (audit #41)', async () => {
    const before = getLogoutEpoch();
    let epochDuringRemote = before;
    mockedRemote.mockImplementationOnce(async () => {
      epochDuringRemote = getLogoutEpoch();
    });

    await useAuthStore.getState().logout();

    expect(epochDuringRemote).toBeGreaterThan(before);
    expect(getLogoutEpoch()).toBeGreaterThan(epochDuringRemote); // clearSession bumps again
  });

  it('clearSession is synchronous, makes no remote calls, and runs local cleanup', async () => {
    const before = getLogoutEpoch();

    useAuthStore.getState().clearSession();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(getLogoutEpoch()).toBe(before + 1);
    expect(mockedRemote).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEvents.USER_LOGGED_OUT, { reason: 'session_expired' });
    await flush();
    expect(mockedLocal).toHaveBeenCalledTimes(1);
  });

  it('clearSession on an already signed-out store does not re-fire logout analytics', () => {
    useAuthStore.setState({ accessToken: null, isAuthenticated: false, user: null });
    jest.clearAllMocks();
    useAuthStore.getState().clearSession();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(resetUser).not.toHaveBeenCalled();
  });

  // #582: clearing the query cache makes every mounted query fetch again,
  // and writing to the store re-renders every screen that subscribes to all
  // of it. Doing either for a session that is already gone fed a loop of
  // about 100 requests in two seconds.
  describe('clearSession on a session that has already ended', () => {
    it('does nothing the second time: no store write, no cleanup, no analytics', async () => {
      useAuthStore.getState().clearSession();
      await flush();
      expect(mockedLocal).toHaveBeenCalledTimes(1);
      jest.clearAllMocks();
      const stateAfterFirst = useAuthStore.getState();
      const onWrite = jest.fn();
      const unsubscribe = useAuthStore.subscribe(onWrite);

      useAuthStore.getState().clearSession();
      useAuthStore.getState().clearSession();
      await flush();
      unsubscribe();

      expect(onWrite).not.toHaveBeenCalled();
      // Same object: a subscriber to the whole store has nothing to re-render for.
      expect(useAuthStore.getState()).toBe(stateAfterFirst);
      expect(mockedLocal).not.toHaveBeenCalled();
      expect(trackEvent).not.toHaveBeenCalled();
      expect(resetUser).not.toHaveBeenCalled();
    });

    it('still advances the logout epoch, so a refresh in flight stays discarded (audit #41)', () => {
      useAuthStore.getState().clearSession();
      const before = getLogoutEpoch();

      useAuthStore.getState().clearSession();

      expect(getLogoutEpoch()).toBe(before + 1);
    });

    it.each([
      ['a refresh token', { refreshToken: 'r' }],
      ['a user', { user: makeUser() }],
      ['an access token', { accessToken: 'a' }],
      ['the authenticated flag', { isAuthenticated: true }],
    ])('is not fooled by a half-cleared store: %s alone is still a session to end', async (_label, leftover) => {
      useAuthStore.setState({
        accessToken: null,
        refreshToken: null,
        user: null,
        isAuthenticated: false,
        ...leftover,
      });

      useAuthStore.getState().clearSession();
      await flush();

      expect(useAuthStore.getState()).toMatchObject({
        accessToken: null,
        refreshToken: null,
        user: null,
        isAuthenticated: false,
      });
      expect(mockedLocal).toHaveBeenCalledTimes(1);
    });

    it('a sign-in after a sign-out can be ended again', async () => {
      useAuthStore.getState().clearSession();
      useAuthStore.getState().setAuthToken('a2', 'r2');
      jest.clearAllMocks();

      useAuthStore.getState().clearSession();
      await flush();

      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(mockedLocal).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith(AnalyticsEvents.USER_LOGGED_OUT, { reason: 'session_expired' });
    });
  });

  it('tolerates a throwing local cleanup hook', () => {
    setSessionHooks({ localCleanup: () => { throw new Error('boom'); } });
    expect(() => useAuthStore.getState().clearSession()).not.toThrow();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('exposes clearSession through useAuthActions', () => {
    const { result } = renderHook(() => useAuthActions());
    expect(typeof result.current.clearSession).toBe('function');
  });
});

describe('auth-store rehydration', () => {
  type RehydrateCb = (state: unknown, error?: unknown) => void;
  const getOnRehydrate = (): RehydrateCb =>
    (useAuthStore as unknown as {
      persist: { getOptions: () => { onRehydrateStorage: () => RehydrateCb } };
    }).persist.getOptions().onRehydrateStorage();

  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'a', refreshToken: 'r', user: makeUser(), isAuthenticated: true, isLoading: true });
  });

  // Audit #34: persist calls the callback with (undefined, error) when
  // AsyncStorage is corrupt/unreadable. isLoading must still clear or
  // app/index.tsx shows "Loading…" forever.
  it('clears isLoading and starts logged out when hydration fails', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    getOnRehydrate()(undefined, new Error('corrupt'));
    expect(useAuthStore.getState()).toMatchObject({
      isLoading: false,
      isAuthenticated: false,
      accessToken: null,
      refreshToken: null,
      user: null,
    });
    warn.mockRestore();
  });

  it('clears isLoading on successful hydration', () => {
    getOnRehydrate()(useAuthStore.getState(), undefined);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});

describe('auth-store updateUser', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    jest.clearAllMocks();
  });

  it('merges fields into the current user without re-firing login analytics', () => {
    useAuthStore.getState().setUser(makeUser({ role: UserRole.PLAYER }));
    jest.clearAllMocks();

    useAuthStore.getState().updateUser({ role: UserRole.COACH });

    expect(useAuthStore.getState().user).toMatchObject({ id: 'user-1', role: UserRole.COACH, email: 'test@example.com' });
    expect(trackEvent).not.toHaveBeenCalled();
    expect(identifyUser).not.toHaveBeenCalled();
    // A role change refreshes the derived user properties (#616).
    expect(setUserProperties).toHaveBeenCalledWith({
      role: UserRole.COACH,
      is_parent: false,
      is_player: false,
      app_version: '1.5.0',
    });
  });

  it('refreshes user properties for a guardian link but not for a name edit', () => {
    useAuthStore.getState().setUser(makeUser({ role: UserRole.COACH }));
    jest.clearAllMocks();

    useAuthStore.getState().updateUser({ name: 'New Name' });
    expect(setUserProperties).not.toHaveBeenCalled();

    useAuthStore.getState().updateUser({
      guardianOf: [{ childId: 'c1', childName: 'Kid', relationship: 'MOTHER', isPrimary: true }],
    });
    expect(setUserProperties).toHaveBeenCalledWith(expect.objectContaining({ role: UserRole.COACH, is_parent: true }));
    expect(JSON.stringify((setUserProperties as jest.Mock).mock.calls)).not.toContain('Kid');
  });

  it('is a no-op when nobody is logged in', () => {
    useAuthStore.getState().updateUser({ role: UserRole.COACH });
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('is exposed through useAuthActions', () => {
    const { result } = renderHook(() => useAuthActions());
    expect(typeof result.current.updateUser).toBe('function');
  });
});
