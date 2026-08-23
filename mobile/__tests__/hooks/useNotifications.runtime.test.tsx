/**
 * Runtime tests for useNotificationSetup.
 *
 * Covers the full effect path:
 *   - bails when no auth token
 *   - bails when not running on a physical device
 *   - bails when permissions are denied
 *   - registers the push token with the backend on success
 *   - swallows backend errors silently
 *   - subscribes to tap responses and routes by data payload
 *   - cleans up the subscription on unmount
 *
 * Mocks expo-notifications, expo-device, expo-constants, expo-router, and
 * the apiClient. The auth-store is exercised via its real Zustand setter
 * to flip `accessToken` between renders.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { apiClient } from '../../services/api-client';
import { useAuthStore } from '../../store/auth-store';
import {
  useNotificationSetup,
  unregisterPushToken,
  getRegisteredPushToken,
} from '../../hooks/useNotifications';

const mockedPost = apiClient.post as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

// expo-device — control isDevice flag per test via a getter so mutation
// from test bodies actually takes effect when the hook reads it.
const mockDeviceState = { isDevice: true };
jest.mock('expo-device', () => ({
  get isDevice() {
    return mockDeviceState.isDevice;
  },
}));

// expo-constants — provide a deterministic projectId.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        eas: { projectId: 'test-project-id' },
      },
    },
  },
}));

// expo-notifications — capture the response listener handler so tests can
// invoke it directly to simulate a notification tap. We stash state on a
// global-ish object (var hoisted, mock-prefixed name allowed by jest) to
// avoid the "out of scope variable" guard.
const mockNotificationsState: {
  removeMock: jest.Mock;
  lastHandler: ((response: unknown) => void) | null;
} = {
  removeMock: jest.fn(),
  lastHandler: null,
};
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn((handler) => {
    mockNotificationsState.lastHandler = handler;
    return { remove: mockNotificationsState.removeMock };
  }),
}));

// expo-router — capture the push() function so tests can assert routing.
const mockRouter = {
  push: jest.fn(),
};
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockRouter.push,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  }),
}));

const mockedGetPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockedRequestPermissions =
  Notifications.requestPermissionsAsync as jest.Mock;
const mockedGetToken = Notifications.getExpoPushTokenAsync as jest.Mock;
const mockedAddListener =
  Notifications.addNotificationResponseReceivedListener as jest.Mock;

// Helper: set authenticated state directly (bypasses analytics in setUser).
function setAuthenticated(token: string | null) {
  useAuthStore.setState({
    accessToken: token,
    isAuthenticated: token !== null,
    isLoading: false,
  });
}

describe('useNotificationSetup runtime', () => {
  beforeEach(async () => {
    // Forget any token a previous test registered (module-level state).
    mockedDelete.mockResolvedValue({ data: { success: true } });
    await unregisterPushToken();
    jest.clearAllMocks();
    mockNotificationsState.lastHandler = null;
    setAuthenticated(null);
    // Default device flag — physical device.
    mockDeviceState.isDevice = true;
    // Default to platform iOS.
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => 'ios',
    });
  });

  // Audit #62: the effect is keyed on the session, not the access-token
  // string — a refresh must not re-prompt / re-register.
  it('does not re-register when only the access token rotates', async () => {
    setAuthenticated('jwt-1');
    mockedGetPermissions.mockResolvedValue({ status: 'granted' });
    mockedGetToken.mockResolvedValue({ data: 'tok' });
    mockedPost.mockResolvedValue({ data: { success: true } });

    renderHook(() => useNotificationSetup());
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));

    act(() => {
      useAuthStore.getState().setAuthToken('jwt-2', 'refresh-2');
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedAddListener).toHaveBeenCalledTimes(1);

    mockedDelete.mockResolvedValueOnce({ data: { success: true } });
    await unregisterPushToken();
  });

  // Audit #62: a rejected permission/token promise must not become an
  // unhandled rejection.
  it('swallows a rejection from the permission / push-token APIs', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockRejectedValueOnce(new Error('permissions API unavailable'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    renderHook(() => useNotificationSetup());
    await waitFor(() => expect(mockedGetPermissions).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  describe('unregisterPushToken (audit #18)', () => {
    it('is a no-op when nothing was registered', async () => {
      expect(getRegisteredPushToken()).toBeNull();
      await unregisterPushToken();
      expect(mockedDelete).not.toHaveBeenCalled();
    });

    it('deletes exactly the token this device registered and forgets it on success', async () => {
      setAuthenticated('jwt-token');
      mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
      mockedGetToken.mockResolvedValueOnce({ data: 'ExponentPushToken[dev]' });
      mockedPost.mockResolvedValueOnce({ data: { success: true } });
      renderHook(() => useNotificationSetup());
      await waitFor(() => expect(getRegisteredPushToken()).toBe('ExponentPushToken[dev]'));

      mockedDelete.mockResolvedValueOnce({ data: { success: true } });
      await unregisterPushToken(4000);

      expect(mockedDelete).toHaveBeenCalledWith('/auth/push-token', {
        data: { token: 'ExponentPushToken[dev]' },
        timeout: 4000,
      });
      expect(getRegisteredPushToken()).toBeNull();
    });

    it('keeps the local record and rethrows when the delete fails', async () => {
      setAuthenticated('jwt-token');
      mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
      mockedGetToken.mockResolvedValueOnce({ data: 'tok-keep' });
      mockedPost.mockResolvedValueOnce({ data: { success: true } });
      renderHook(() => useNotificationSetup());
      await waitFor(() => expect(getRegisteredPushToken()).toBe('tok-keep'));

      mockedDelete.mockRejectedValueOnce(new Error('offline'));
      await expect(unregisterPushToken()).rejects.toThrow('offline');
      expect(getRegisteredPushToken()).toBe('tok-keep');

      // Clean up module state for later tests.
      mockedDelete.mockResolvedValueOnce({ data: { success: true } });
      await unregisterPushToken();
    });
  });

  it('does nothing when there is no access token', () => {
    renderHook(() => useNotificationSetup());

    expect(mockedGetPermissions).not.toHaveBeenCalled();
    expect(mockedRequestPermissions).not.toHaveBeenCalled();
    expect(mockedAddListener).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('skips token registration on a non-device (simulator) but still subscribes to taps', async () => {
    mockDeviceState.isDevice = false;
    setAuthenticated('jwt-token');

    renderHook(() => useNotificationSetup());

    // The listener subscribe is synchronous within the effect.
    expect(mockedAddListener).toHaveBeenCalledTimes(1);
    // Token registration short-circuits before requesting permissions.
    await waitFor(() => {
      expect(mockedGetPermissions).not.toHaveBeenCalled();
    });
    expect(mockedRequestPermissions).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('does not request a token when permissions are denied', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'denied' });
    mockedRequestPermissions.mockResolvedValueOnce({ status: 'denied' });

    renderHook(() => useNotificationSetup());

    await waitFor(() => {
      expect(mockedRequestPermissions).toHaveBeenCalledTimes(1);
    });
    expect(mockedGetToken).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('skips the request prompt when permissions are already granted', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'ExponentPushToken[abc]' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledTimes(1);
    });
    expect(mockedRequestPermissions).not.toHaveBeenCalled();
    expect(mockedGetToken).toHaveBeenCalledWith({ projectId: 'test-project-id' });
    expect(mockedPost).toHaveBeenCalledWith('/auth/push-token', {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
  });

  it('registers the token after prompting when status starts as undetermined', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'undetermined' });
    mockedRequestPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'ExponentPushToken[xyz]' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/auth/push-token', {
        token: 'ExponentPushToken[xyz]',
        platform: 'ios',
      });
    });
  });

  it('reports the android platform when running on android', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      get: () => 'android',
    });
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/auth/push-token', {
        token: 'tok',
        platform: 'android',
      });
    });
  });

  it('silently swallows backend failures when registering the token', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockRejectedValueOnce(new Error('500'));

    // Should not throw — register failure is intentionally swallowed.
    renderHook(() => useNotificationSetup());

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    // A failed registration must not be "remembered" as registered.
    expect(getRegisteredPushToken()).toBeNull();
  });

  it('routes to the game screen when a notification with gameId is tapped', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => expect(mockNotificationsState.lastHandler).not.toBeNull());

    act(() => {
      mockNotificationsState.lastHandler?.({
        notification: { request: { content: { data: { gameId: 'g1' } } } },
      });
    });

    expect(mockRouter.push).toHaveBeenCalledWith('/games/g1');
  });

  it('routes to the team screen when a notification with teamId is tapped', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => expect(mockNotificationsState.lastHandler).not.toBeNull());

    act(() => {
      mockNotificationsState.lastHandler?.({
        notification: { request: { content: { data: { teamId: 't1' } } } },
      });
    });

    expect(mockRouter.push).toHaveBeenCalledWith('/teams/t1');
  });

  it('prefers gameId routing when both gameId and teamId are present', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => expect(mockNotificationsState.lastHandler).not.toBeNull());

    act(() => {
      mockNotificationsState.lastHandler?.({
        notification: {
          request: { content: { data: { gameId: 'g1', teamId: 't1' } } },
        },
      });
    });

    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith('/games/g1');
  });

  it('does not navigate when the notification carries no routing data', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => expect(mockNotificationsState.lastHandler).not.toBeNull());

    act(() => {
      mockNotificationsState.lastHandler?.({
        notification: { request: { content: { data: {} } } },
      });
    });

    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('handles a notification with a missing data field without crashing', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    renderHook(() => useNotificationSetup());

    await waitFor(() => expect(mockNotificationsState.lastHandler).not.toBeNull());

    act(() => {
      mockNotificationsState.lastHandler?.({
        notification: { request: { content: {} } },
      });
    });

    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('removes the response subscription on unmount', async () => {
    setAuthenticated('jwt-token');
    mockedGetPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockedGetToken.mockResolvedValueOnce({ data: 'tok' });
    mockedPost.mockResolvedValueOnce({ data: { success: true } });

    const { unmount } = renderHook(() => useNotificationSetup());

    await waitFor(() => expect(mockedAddListener).toHaveBeenCalledTimes(1));

    unmount();
    expect(mockNotificationsState.removeMock).toHaveBeenCalledTimes(1);
  });
});
