/**
 * The web invite page's Open in App button deep-links to
 * `hooplings://invite/<token>?src=web` (#964, #967). Through Expo Router's own
 * URL parsing, `src` must arrive as its own param and never become part of the
 * token, or the by-token lookup would 404 a valid invitation.
 */

import { getStateFromPath } from 'expo-router/build/fork/getStateFromPath';
import { extractExpoPathFromURL } from 'expo-router/build/fork/extractPathFromURL';

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const CONFIG = { screens: { 'invite/[token]': 'invite/:token' } };

function paramsFor(url: string): unknown {
  const state = getStateFromPath(extractExpoPathFromURL([], url), CONFIG as never);
  return state?.routes[0]?.params;
}

describe('/invite/[token] route params', () => {
  it('reads ?src=web as its own param, leaving the token intact', () => {
    expect(paramsFor(`hooplings://invite/${TOKEN}?src=web`)).toEqual({ token: TOKEN, src: 'web' });
  });

  it('has no src on a plain link or the Universal Link', () => {
    expect(paramsFor(`hooplings://invite/${TOKEN}`)).toEqual({ token: TOKEN });
    expect(paramsFor(`https://hooplings.com/invite/${TOKEN}`)).toEqual({ token: TOKEN });
  });
});
