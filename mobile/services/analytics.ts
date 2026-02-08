import * as amplitude from '@amplitude/analytics-react-native';
import Constants from 'expo-constants';

export const AnalyticsEvents = {
  APP_OPENED: 'app_opened',
  USER_LOGGED_IN: 'user_logged_in',
  USER_LOGGED_OUT: 'user_logged_out',
  GAME_CREATED: 'game_created',
  GAME_UPDATED: 'game_updated',
  GAME_DELETED: 'game_deleted',
  SCREEN_VIEWED: 'screen_viewed',
} as const;

type AnalyticsEvent = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

let initialized = false;

/**
 * Initialize Amplitude analytics.
 * No-ops gracefully if the API key is not configured.
 */
export async function initAnalytics(): Promise<void> {
  const apiKey = Constants.expoConfig?.extra?.amplitudeApiKey;
  if (!apiKey) {
    if (__DEV__) {
      console.log('[Analytics] No Amplitude API key configured, skipping initialization');
    }
    return;
  }

  try {
    await amplitude.init(apiKey).promise;
    initialized = true;
  } catch (error) {
    if (__DEV__) {
      console.warn('[Analytics] Failed to initialize Amplitude:', error);
    }
  }
}

/**
 * Track an analytics event with optional properties.
 */
export function trackEvent(
  event: AnalyticsEvent | string,
  properties?: Record<string, unknown>,
): void {
  if (!initialized) return;

  try {
    amplitude.track(event, properties);
  } catch (error) {
    if (__DEV__) {
      console.warn('[Analytics] Failed to track event:', error);
    }
  }
}

/**
 * Identify the current user for analytics.
 */
export function identifyUser(
  userId: string,
  properties?: Record<string, unknown>,
): void {
  if (!initialized) return;

  try {
    amplitude.setUserId(userId);
    if (properties) {
      const identifyObj = new amplitude.Identify();
      for (const [key, value] of Object.entries(properties)) {
        identifyObj.set(key, value as string);
      }
      amplitude.identify(identifyObj);
    }
  } catch (error) {
    if (__DEV__) {
      console.warn('[Analytics] Failed to identify user:', error);
    }
  }
}

/**
 * Reset user identity on logout.
 */
export function resetUser(): void {
  if (!initialized) return;

  try {
    amplitude.reset();
  } catch (error) {
    if (__DEV__) {
      console.warn('[Analytics] Failed to reset user:', error);
    }
  }
}
