/**
 * Tests for utils/return-path — the pending post-login redirect used when a
 * deep link (e.g. /invite/<token>) is opened while logged out — and its
 * integration with postLoginRoute.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  setPendingReturnPath,
  consumePendingReturnPath,
  clearPendingReturnPath,
  isSafeReturnPath,
  RETURN_PATH_KEY,
  RETURN_PATH_TTL_MS,
} from '../../utils/return-path';
import { postLoginRoute, markRoleChosen, HOME_ROUTE, ROLE_ONBOARDING_ROUTE } from '../../utils/role-onboarding';
import { UserRole } from '../../../shared/types';

describe('return-path', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  it('stores and consumes a path exactly once', async () => {
    await setPendingReturnPath('/invite/abc');
    expect(await consumePendingReturnPath()).toBe('/invite/abc');
    expect(await consumePendingReturnPath()).toBeNull();
  });

  it('ignores expired entries', async () => {
    await setPendingReturnPath('/invite/abc');
    expect(await consumePendingReturnPath(Date.now() + RETURN_PATH_TTL_MS + 1)).toBeNull();
  });

  it('rejects unsafe paths on write and on read', async () => {
    await setPendingReturnPath('https://evil.example');
    expect(await AsyncStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    await setPendingReturnPath('//evil.example');
    expect(await AsyncStorage.getItem(RETURN_PATH_KEY)).toBeNull();

    await AsyncStorage.setItem(
      RETURN_PATH_KEY,
      JSON.stringify({ path: 'bball-tracker://x', savedAt: Date.now() })
    );
    expect(await consumePendingReturnPath()).toBeNull();
    expect(isSafeReturnPath('/teams')).toBe(true);
    expect(isSafeReturnPath('teams')).toBe(false);
  });

  it('tolerates corrupt storage and storage failures', async () => {
    await AsyncStorage.setItem(RETURN_PATH_KEY, '{not json');
    expect(await consumePendingReturnPath()).toBeNull();

    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    await expect(setPendingReturnPath('/invite/x')).resolves.toBeUndefined();
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await consumePendingReturnPath()).toBeNull();
    await expect(clearPendingReturnPath()).resolves.toBeUndefined();
  });

  describe('postLoginRoute integration', () => {
    const coach = { id: 'u1', role: UserRole.COACH };
    const player = { id: 'u2', role: UserRole.PLAYER };

    it('returns the pending path instead of Home after login', async () => {
      await setPendingReturnPath('/invite/abc');
      expect(await postLoginRoute(coach)).toBe('/invite/abc');
      // consumed: the next login goes Home
      expect(await postLoginRoute(coach)).toBe(HOME_ROUTE);
    });

    it('still routes to the role step first and keeps the path pending', async () => {
      await setPendingReturnPath('/invite/abc');
      expect(await postLoginRoute(player)).toBe(ROLE_ONBOARDING_ROUTE);
      await markRoleChosen(player.id);
      expect(await postLoginRoute(player)).toBe('/invite/abc');
    });

    it('falls back to Home when nothing is pending', async () => {
      expect(await postLoginRoute(coach)).toBe(HOME_ROUTE);
    });
  });
});
