/**
 * Push notification setup and management
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { apiClient } from '../services/api-client';
import { useIsAuthenticated } from '../store/auth-store';

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * The Expo push token this device last registered with the backend, so logout
 * can `DELETE /auth/push-token` for exactly that token (audit #18). Null until
 * a registration succeeds, and after it has been unregistered.
 */
let registeredPushToken: string | null = null;

export function getRegisteredPushToken(): string | null {
  return registeredPushToken;
}

/**
 * Unregister this device's push token from the backend. No-op when nothing
 * was registered. Must run while the access token is still valid (i.e. before
 * the auth store is cleared). Throws on request failure so the caller decides
 * whether that matters; the local record is cleared only on success.
 */
export async function unregisterPushToken(timeoutMs?: number): Promise<void> {
  const token = registeredPushToken;
  if (!token) return;
  await apiClient.delete('/auth/push-token', {
    data: { token },
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  registeredPushToken = null;
}

/**
 * Register for push notifications and return the token
 */
async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) {
    return null; // Push notifications only work on physical devices
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  return tokenData.data;
}

/**
 * Hook to set up push notifications on app launch
 * Registers token with backend and handles notification taps
 */
export function useNotificationSetup() {
  const router = useRouter();
  const responseListener = useRef<Notifications.EventSubscription>(null);
  // Keyed on the *session*, not the access-token string: a token refresh
  // every ~10 minutes must not re-run permission prompts and re-POST the
  // push token (audit #62).
  const isAuthenticated = useIsAuthenticated();

  useEffect(() => {
    if (!isAuthenticated) return;

    // Register push token. Every step can reject (permission API, Expo push
    // service, backend) — none of it is critical, but an unhandled rejection
    // here surfaces as a red box / Sentry noise.
    registerForPushNotificationsAsync()
      .then(async (token) => {
        if (!token) return;
        await apiClient.post('/auth/push-token', {
          token,
          platform: Platform.OS,
        });
        registeredPushToken = token;
      })
      .catch(() => {
        // Silently fail - token registration is not critical
      });

    // Handle notification taps (deep-link to relevant screen)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data ?? {};

        if (data.gameId) {
          router.push(`/games/${data.gameId}`);
        } else if (data.teamId) {
          router.push(`/teams/${data.teamId}`);
        }
      }
    );

    return () => {
      responseListener.current?.remove();
    };
  }, [isAuthenticated, router]);
}
