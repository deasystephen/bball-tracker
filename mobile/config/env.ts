import Constants from 'expo-constants';

/**
 * Which API host the app talks to — the ONE place that decides it (domain
 * migration PR3, D11). `services/api-client.ts` and `services/socket.ts` import
 * `getApiUrl()`; never read `Constants.expoConfig.extra.apiUrl` elsewhere.
 *
 * Resolution order:
 *   1. `extra.apiUrl` from app.config.js — set at build/OTA publish time from
 *      APP_ENV (production/preview → the production API, otherwise the local
 *      dev server). An OTA published with APP_ENV unset ships the dev host to
 *      every device (see CLAUDE.md "OTA env gotcha"); `__tests__/app-config.test.ts`
 *      pins that mapping.
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

export function getApiUrl(): string {
  const configured = Constants.expoConfig?.extra?.apiUrl;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return __DEV__ ? DEV_API_URL : PRODUCTION_API_URL;
}

export const config = {
  get apiUrl(): string {
    return getApiUrl();
  },
  environment: __DEV__ ? 'development' : 'production',
} as const;
