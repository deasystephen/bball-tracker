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
 *      dev server, or LOCAL_API_URL when set); `__tests__/app-config.test.ts` pins
 *      that mapping. A release bundle (`!__DEV__`) ignores a loopback value
 *      (`isLoopbackUrl`) and uses the production API instead (#721): an OTA
 *      published with APP_ENV unset ships the dev host (see
 *      docs/deployment/mobile-builds-and-ota.md "OTA env gotcha"), and no
 *      release bundle has a reason to call the phone's own loopback. A LAN
 *      host (192.168.x.y, a .local name, …) stays allowed in release on
 *      purpose: it is how a local Release build is pointed at a development
 *      backend (`LOCAL_API_URL=http://<lan-ip>:3000`), never by accident:
 *      a shell's `API_URL` does not reach the dev branch of app.config.js.
 *   2. Otherwise the dev server when `__DEV__`, else the production API.
 *
 * The device cannot report a mis-published manifest by itself (it also has no
 * Sentry DSN, and the redirect happens before Sentry starts), so
 * `getApiUrlResolution().loopbackIgnored` is shown on the About screen.
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

/** Hosts that name this device, or the development machine as seen from an emulator or container. */
const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '[::1]', '[::]', '10.0.2.2', 'host.docker.internal']);
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

/**
 * The host of an absolute URL, lower-cased and without a trailing dot, or null.
 * Hand-rolled on purpose: React Native's `URL` polyfill reads `hostname` with
 * a regex that stops at the first colon (`http://[::1]:3000` gives `[`), while
 * Jest runs Node's WHATWG `URL`, so a `new URL()` guard would pass its tests
 * and misbehave on a device.
 */
function urlHost(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]/?#]*\]|[^:/?#]*)(?::\d*)?(?:[/?#]|$)/i.exec(url);
  if (!match || match[1].length === 0) return null;
  return match[1].toLowerCase().replace(/\.$/, '');
}

/** True when `url` points at this device: localhost (and *.localhost), 127.0.0.0/8, 0.0.0.0, [::1], [::], 10.0.2.2, host.docker.internal. */
export function isLoopbackUrl(url: string): boolean {
  const host = urlHost(url);
  if (host === null) return false;
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || IPV4_LOOPBACK.test(host);
}

export interface ApiUrlResolution {
  url: string;
  /** The manifest named a loopback host and this release bundle used the production API instead (#721). */
  loopbackIgnored: boolean;
}

/** The socket resolves the host on every connect: warn once per launch, not per call. */
let loopbackWarned = false;

/** `getApiUrl()` plus whether the manifest's loopback host was overridden; the About screen shows the latter. */
export function getApiUrlResolution(): ApiUrlResolution {
  const configured = Constants.expoConfig?.extra?.apiUrl;
  if (typeof configured === 'string' && configured.length > 0) {
    if (!__DEV__ && isLoopbackUrl(configured)) {
      // Fail closed (#721): a mis-published OTA must not point every device
      // at its own loopback. The URL itself stays out of the log. In a
      // release bundle this is only a breadcrumb once Sentry has started; the
      // About screen is where a mis-publish is visible.
      if (!loopbackWarned) {
        loopbackWarned = true;
        log.warn('getApiUrl: ignoring loopback apiUrl in a release bundle');
      }
      return { url: PRODUCTION_API_URL, loopbackIgnored: true };
    }
    return { url: configured, loopbackIgnored: false };
  }
  return { url: __DEV__ ? DEV_API_URL : PRODUCTION_API_URL, loopbackIgnored: false };
}

export function getApiUrl(): string {
  return getApiUrlResolution().url;
}

export const config = {
  get apiUrl(): string {
    return getApiUrl();
  },
  environment: __DEV__ ? 'development' : 'production',
} as const;
