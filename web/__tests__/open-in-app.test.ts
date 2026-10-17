import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_STORE_URL,
  PLAY_STORE_URL,
  STORE_FALLBACK_DELAY_MS,
  inviteDeepLink,
  openInApp,
  type OpenInAppEnv,
} from '../lib/open-in-app';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const TOKEN = 'abcDEF123_-xyz';

function makeEnv(userAgent: string) {
  const doc = new EventTarget();
  const navigate = vi.fn<(url: string) => void>();
  const env: OpenInAppEnv = { userAgent, document: doc as unknown as OpenInAppEnv['document'], navigate };
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

  it('builds hooplings://invite/<token>', () => {
    expect(inviteDeepLink(TOKEN)).toBe(`hooplings://invite/${TOKEN}`);
  });

  it('navigates to the deep link immediately', () => {
    const { env, navigate } = makeEnv(IOS_UA);
    openInApp(TOKEN, env);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`hooplings://invite/${TOKEN}`);
  });

  it.each([
    ['iPhone', IOS_UA],
    ['iPad', IPAD_UA],
  ])('falls back to the App Store on %s when the page never hid', (_label, ua) => {
    const { env, navigate } = makeEnv(ua);
    openInApp(TOKEN, env);
    vi.advanceTimersByTime(STORE_FALLBACK_DELAY_MS - 1);
    expect(navigate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(navigate).toHaveBeenLastCalledWith(APP_STORE_URL);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('stays put on iOS when the page hid (the app opened)', () => {
    const { env, navigate, hide } = makeEnv(IOS_UA);
    openInApp(TOKEN, env);
    hide();
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith(APP_STORE_URL);
  });

  it('uses the Play Store URL on Android', () => {
    const { env, navigate } = makeEnv(ANDROID_UA);
    openInApp(TOKEN, env);
    vi.runAllTimers();
    expect(navigate).toHaveBeenLastCalledWith(PLAY_STORE_URL);
  });

  it('stays put on Android when the page hid', () => {
    const { env, navigate, hide } = makeEnv(ANDROID_UA);
    openInApp(TOKEN, env);
    hide();
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('never redirects a desktop browser to a store', () => {
    const { env, navigate } = makeEnv(DESKTOP_UA);
    openInApp(TOKEN, env);
    vi.runAllTimers();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`hooplings://invite/${TOKEN}`);
  });

  it('removes its visibilitychange listener after the fallback window', () => {
    const { env } = makeEnv(IOS_UA);
    const remove = vi.spyOn(env.document, 'removeEventListener');
    openInApp(TOKEN, env);
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
