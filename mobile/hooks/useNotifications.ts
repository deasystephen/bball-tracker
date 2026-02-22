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
import { useAuthStore } from '../store/auth-store';

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
  const { accessToken } = useAuthStore();

  useEffect(() => {
    if (!accessToken) return;

    // Register push token
    registerForPushNotificationsAsync().then(async (token) => {
      if (token) {
        try {
          await apiClient.post('/auth/push-token', {
            token,
            platform: Platform.OS,
          });
        } catch {
          // Silently fail - token registration is not critical
        }
      }
    });

    // Handle notification taps (deep-link to relevant screen)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;

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
  }, [accessToken, router]);
}
