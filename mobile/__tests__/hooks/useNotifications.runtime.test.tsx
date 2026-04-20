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

import { apiClient } from '../../services/api-client';
import { useAuthStore } from '../../store/auth-store';

const mockedPost = apiClient.post as jest.Mock;

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

import * as Notifications from 'expo-notifications';
import { useNotificationSetup } from '../../hooks/useNotifications';

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
  beforeEach(() => {
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
