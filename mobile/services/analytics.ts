import * as amplitude from '@amplitude/analytics-react-native';
import Constants from 'expo-constants';
import { log } from './log';

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

/**
 * What the Amplitude SDK attaches to every event, stated explicitly (#559).
 *
 * `amplitude.init(apiKey)` with no options turns every one of these on, which
 * is how the app came to send more than the privacy-label draft assumed. The
 * values below are a decision, not a default: they are what the App Privacy
 * labels in `docs/release/app-store-submission.md` and the "Retention" section
 * of `docs/runbooks/data-subject-requests.md` declare. Change one here and
 * change it there; `__tests__/services/analytics.test.ts` pins the set.
 *
 * - `ipAddress: true` is deliberate. Amplitude resolves the request IP into
 *   city, region and country on its servers, and that coarse location is
 *   wanted for analytics. It is declared as Coarse Location on the label.
 * - `country: false` goes with it. That option is the country the DEVICE
 *   reports, and turning it on disables the server-side lookup, which would
 *   lose the city.
 * - `adid: false`. The Android advertising id serves ad attribution, the app
 *   shows no ads, and sending it would make the "no tracking" answer on the
 *   label false. iOS is unaffected: the SDK never reads the IDFA there.
 * - Everything else is device and OS context used to read the six events.
 */
export const AMPLITUDE_TRACKING_OPTIONS: Required<amplitude.Types.ReactNativeTrackingOptions> = {
  adid: false,
  appSetId: true,
  carrier: true,
  country: false,
  deviceManufacturer: true,
  deviceModel: true,
  idfv: true,
  ipAddress: true,
  language: true,
  osName: true,
  osVersion: true,
  platform: true,
};

let initialized = false;

/**
 * Initialize Amplitude analytics.
 * No-ops gracefully if the API key is not configured.
 */
export async function initAnalytics(): Promise<void> {
  const apiKey = Constants.expoConfig?.extra?.amplitudeApiKey;
  if (!apiKey) {
    log.debug('[Analytics] No Amplitude API key configured, skipping initialization');
    return;
  }

  try {
    await amplitude.init(apiKey, undefined, {
      trackingOptions: AMPLITUDE_TRACKING_OPTIONS,
    }).promise;
    initialized = true;
  } catch (error) {
    log.warn('[Analytics] Failed to initialize Amplitude', { error });
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
    log.warn('[Analytics] Failed to track event', { event, error });
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
    log.warn('[Analytics] Failed to identify user', { error });
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
    log.warn('[Analytics] Failed to reset user', { error });
  }
}
