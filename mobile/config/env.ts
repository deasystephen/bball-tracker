import Constants from 'expo-constants';

import { log } from '../services/log';

/**
 * Which API host the app talks to — the ONE place that decides it (domain
 * migration PR3, D11). `services/api-client.ts` and `services/socket.ts` import
 * `getApiUrl()`; never read `Constants.expoConfig.extra.apiUrl` elsewhere.
 *
 * Resolution order:
 *   1. `extra.apiUrl` from app.config.js — set at build/OTA publish time from
 *      APP_ENV (production/preview → the production API, otherwise the local
 *      dev server); `__tests__/app-config.test.ts` pins that mapping. A
 *      release bundle (`!__DEV__`) ignores a loopback value (127.0.0.1,
 *      localhost, 10.0.2.2, [::1]) and uses the production API instead (#721):
 *      an OTA published with APP_ENV unset ships the dev host (see
 *      docs/deployment/mobile-builds-and-ota.md "OTA env gotcha"), and no
 *      release bundle has a reason to call the phone's own loopback.
 *   2. Otherwise the dev server when `__DEV__`, else the production API.
 */
export const PRODUCTION_API_URL = 'https://api.hooplings.com';

/**
 * The custom URL scheme the app asks WorkOS to redirect sign-in to
 * (`hooplings://auth/callback`, #504). Passed explicitly to
 * `Linking.createURL` so the redirect never depends on the order of the
 * `scheme` array in app.config.js; `__tests__/app-config.test.ts` pins that
 * the binary registers it. The backend allowlist (`ALLOWED_REDIRECT_SCHEMES`)
 * and the WorkOS dashboard must list the same value.
 */
export const APP_URL_SCHEME = 'hooplings';
export const DEV_API_URL = 'http://127.0.0.1:3000';

/**
 * The address people write to for help (#450). The same value is the
 * `Reply-To` and the footer of every email the backend sends
 * (`backend/src/services/mailer/templates/brand.ts`); `__tests__/config/env.test.ts`
 * fails when the two differ.
 */
export const SUPPORT_EMAIL = 'support@hooplings.com';

/** A URL whose host is this device (or the Android emulator's host alias). */
const LOOPBACK_HOST = /^https?:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2|\[::1\])(:\d+)?(\/|$)/i;

/** The socket resolves the host on every connect: warn once per launch, not per call. */
let loopbackWarned = false;

export function getApiUrl(): string {
  const configured = Constants.expoConfig?.extra?.apiUrl;
  if (typeof configured === 'string' && configured.length > 0) {
    if (!__DEV__ && LOOPBACK_HOST.test(configured)) {
      // Fail closed (#721): a mis-published OTA must not point every device
      // at its own loopback. The URL itself stays out of the log.
      if (!loopbackWarned) {
        loopbackWarned = true;
        log.warn('getApiUrl: ignoring loopback apiUrl in a release bundle');
      }
      return PRODUCTION_API_URL;
    }
    return configured;
  }
  return __DEV__ ? DEV_API_URL : PRODUCTION_API_URL;
}

export const config = {
  get apiUrl(): string {
    return getApiUrl();
  },
  environment: __DEV__ ? 'development' : 'production',
} as const;
