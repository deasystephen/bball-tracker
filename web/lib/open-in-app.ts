// App Store Connect app id (mobile/eas.json submit.production.ios.ascAppId). Apple
// resolves the id-only form; it shows "not available" until the app is released.
export const APP_STORE_URL = 'https://apps.apple.com/app/id6758903514';
// Placeholder until an Android listing exists (#30).
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.bballtracker.mobile';

/** How long the page waits for the app to take over before it falls back to the store. */
export const STORE_FALLBACK_DELAY_MS = 1500;

/** The browser surface `openInApp` touches, injectable so tests need no DOM. */
export interface OpenInAppEnv {
  userAgent: string;
  /** `navigator.maxTouchPoints`: tells iPadOS 13+ (desktop "Macintosh" UA) from a Mac. */
  maxTouchPoints: number;
  document: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  navigate: (url: string) => void;
}

function browserEnv(): OpenInAppEnv {
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    document,
    navigate: (url) => {
      window.location.href = url;
    },
  };
}

export function inviteDeepLink(token: string): string {
  return `hooplings://invite/${token}`;
}

/**
 * Try the custom-scheme link; if the page never hides within the delay (the app
 * did not open), send a phone to its store. Desktop browsers never redirect.
 */
export function openInApp(token: string, env: OpenInAppEnv = browserEnv()): void {
  const isAndroid = /android/i.test(env.userAgent);
  // iPadOS 13+ Safari sends a Macintosh desktop UA; only touch support tells it apart.
  const isIos =
    /iphone|ipad|ipod/i.test(env.userAgent) || (/macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1);
  const storeUrl = isAndroid ? PLAY_STORE_URL : APP_STORE_URL;

  let appOpened = false;
  const onHide = () => {
    appOpened = true;
  };
  env.document.addEventListener('visibilitychange', onHide);

  env.navigate(inviteDeepLink(token));

  setTimeout(() => {
    env.document.removeEventListener('visibilitychange', onHide);
    if (!appOpened && (isAndroid || isIos)) {
      env.navigate(storeUrl);
    }
  }, STORE_FALLBACK_DELAY_MS);
}
