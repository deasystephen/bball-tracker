import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_STORE_RELEASED,
  APP_STORE_URL,
  STORE_FALLBACK_DELAY_MS,
  inviteDeepLink,
  openInApp,
  type OpenInAppEnv,
} from '../lib/open-in-app';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/** iPadOS 12 and earlier, and some in-app browsers, still say "iPad". */
const LEGACY_IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
/** iPadOS 13+ Safari requests the desktop site with a Macintosh UA; only touch support differs. */
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const TOKEN = 'abcDEF123_-xyz';

function makeEnv(userAgent: string, maxTouchPoints = 0) {
  const doc = new EventTarget();
  const navigate = vi.fn<(url: string) => void>();
  const env: OpenInAppEnv = {
    userAgent,
    maxTouchPoints,
    document: doc as unknown as OpenInAppEnv['document'],
    navigate,
  };
  const hide = () => doc.dispatchEvent(new Event('visibilitychange'));
  return { env, navigate, hide };
}

describe('openInApp (#510)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds hooplings://invite/<token>?src=web, the token path unchanged (#964)', () => {
    expect(inviteDeepLink(TOKEN)).toBe(`hooplings://invite/${TOKEN}?src=web`);
    const url = new URL(inviteDeepLink(TOKEN));
    expect(url.pathname).toBe(`/${TOKEN}`);
    expect(url.host).toBe('invite');
    expect(url.searchParams.get('src')).toBe('web');
  });

  it('navigates to the deep link immediately', () => {
    const { env, navigate } = makeEnv(IOS_UA);
    openInApp(TOKEN, env);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`hooplings://invite/${TOKEN}?src=web`);
  });

  it.each([
    ['iPhone', IOS_UA, 5],
    ['legacy iPad UA', LEGACY_IPAD_UA, 5],
    ['iPadOS 13+ (Macintosh UA with touch)', MAC_UA, 5],
  ])('falls back to the App Store on %s when the page never hid', (_label, ua, touchPoints) => {
    const { env, navigate } = makeEnv(ua, touchPoints);
    openInApp(TOKEN, env, true);
    vi.advanceTimersByTime(STORE_FALLBACK_DELAY_MS - 1);
    expect(navigate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(navigate).toHaveBeenLastCalledWith(APP_STORE_URL);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('stays put on iOS until the app is on the App Store (#30)', () => {
    expect(APP_STORE_RELEASED).toBe(false);
    const { env, navigate } = makeEnv(IOS_UA, 5);
    openInApp(TOKEN, env);
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith(APP_STORE_URL);
  });

  it('stays put on iOS when the page hid (the app opened)', () => {
    const { env, navigate, hide } = makeEnv(IOS_UA);
    openInApp(TOKEN, env, true);
    hide();
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith(APP_STORE_URL);
  });

  it('never sends Android to a store: there is no Play listing', () => {
    const { env, navigate } = makeEnv(ANDROID_UA);
    openInApp(TOKEN, env, true);
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('stays put on Android when the page hid', () => {
    const { env, navigate, hide } = makeEnv(ANDROID_UA);
    openInApp(TOKEN, env);
    hide();
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('treats a Macintosh UA without touch as a desktop Mac', () => {
    const { env, navigate } = makeEnv(MAC_UA, 0);
    openInApp(TOKEN, env, true);
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('never redirects a desktop browser to a store', () => {
    const { env, navigate } = makeEnv(DESKTOP_UA);
    openInApp(TOKEN, env, true);
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`hooplings://invite/${TOKEN}?src=web`);
  });

  it('removes its visibilitychange listener after the fallback window', () => {
    const { env } = makeEnv(IOS_UA);
    const remove = vi.spyOn(env.document, 'removeEventListener');
    openInApp(TOKEN, env, true);
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
