/**
 * Tests for the split auth persistence adapter (audit #52).
 *
 * Tokens must land in the ExpoSecureStore native module and never in
 * AsyncStorage; the user/flags half stays in AsyncStorage; a binary without
 * the native module falls back to the legacy all-in-AsyncStorage layout; and
 * the first read after upgrading migrates a legacy blob.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import {
  secureAuthStorage,
  clearPersistedAuth,
  loadSecureStore,
  resetSecureStoreCacheForTests,
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  SecureStoreNative,
} from '../../services/secure-storage';

type MockSecureStore = SecureStoreNative & {
  AFTER_FIRST_UNLOCK: number;
  getValueWithKeyAsync: jest.Mock;
  setValueWithKeyAsync: jest.Mock;
  deleteValueWithKeyAsync: jest.Mock;
  __reset: () => void;
};

const mockedNative = requireOptionalNativeModule as jest.Mock;
// The jest.setup.js mock returns the shared in-memory native module.
const native = requireOptionalNativeModule('ExpoSecureStore') as MockSecureStore;
const nativeGet = (key: string) => native.getValueWithKeyAsync(key, {});

const KEY = 'auth-storage';
const user = { id: 'u1', email: 'a@b.c', name: 'A' };
const blob = (tokens: { accessToken: string | null; refreshToken: string | null }) =>
  JSON.stringify({ state: { ...tokens, user, isAuthenticated: true }, version: 0 });

const parse = (raw: string | null) => JSON.parse(raw as string);

describe('secureAuthStorage', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    native.__reset();
    resetSecureStoreCacheForTests();
    mockedNative.mockReturnValue(native);
  });

  describe('with SecureStore available', () => {
    it('setItem splits tokens into SecureStore and the rest into AsyncStorage', async () => {
      await secureAuthStorage.setItem(KEY, blob({ accessToken: 'at', refreshToken: 'rt' }));

      expect(await nativeGet(ACCESS_TOKEN_KEY)).toBe('at');
      expect(await nativeGet(REFRESH_TOKEN_KEY)).toBe('rt');
      expect(native.setValueWithKeyAsync).toHaveBeenCalledWith('at', ACCESS_TOKEN_KEY, {
        keychainAccessible: native.AFTER_FIRST_UNLOCK,
      });

      const raw = await AsyncStorage.getItem(KEY);
      const stored = parse(raw);
      expect(stored.state.accessToken).toBeNull();
      expect(stored.state.refreshToken).toBeNull();
      expect(stored.state.user).toEqual(user);
      expect(stored.state.isAuthenticated).toBe(true);
      expect(stored.version).toBe(0);
      expect(raw).not.toContain('"at"');
      expect(raw).not.toContain('"rt"');
    });

    it('getItem merges the two halves back together', async () => {
      await secureAuthStorage.setItem(KEY, blob({ accessToken: 'at', refreshToken: 'rt' }));

      const merged = parse(await secureAuthStorage.getItem(KEY));
      expect(merged.state).toEqual({ accessToken: 'at', refreshToken: 'rt', user, isAuthenticated: true });
      expect(merged.version).toBe(0);
    });

    it('setItem with null tokens deletes the SecureStore entries', async () => {
      await secureAuthStorage.setItem(KEY, blob({ accessToken: 'at', refreshToken: 'rt' }));
      await secureAuthStorage.setItem(KEY, blob({ accessToken: null, refreshToken: null }));

      expect(native.deleteValueWithKeyAsync).toHaveBeenCalledWith(ACCESS_TOKEN_KEY, expect.anything());
      expect(native.deleteValueWithKeyAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, expect.anything());
      expect(await nativeGet(ACCESS_TOKEN_KEY)).toBeNull();
      expect(await nativeGet(REFRESH_TOKEN_KEY)).toBeNull();
    });

    it('removeItem / clearPersistedAuth wipe both halves', async () => {
      await secureAuthStorage.setItem(KEY, blob({ accessToken: 'at', refreshToken: 'rt' }));
      await clearPersistedAuth(KEY);

      expect(await AsyncStorage.getItem(KEY)).toBeNull();
      expect(await nativeGet(ACCESS_TOKEN_KEY)).toBeNull();
      expect(await nativeGet(REFRESH_TOKEN_KEY)).toBeNull();
    });

    it('getItem returns null on a fresh install and drops orphaned keychain tokens', async () => {
      await native.setValueWithKeyAsync('stale', ACCESS_TOKEN_KEY, {});

      expect(await secureAuthStorage.getItem(KEY)).toBeNull();
      expect(await nativeGet(ACCESS_TOKEN_KEY)).toBeNull();
    });

    it('getItem treats a throwing keychain read as "no token"', async () => {
      await AsyncStorage.setItem(KEY, blob({ accessToken: null, refreshToken: null }));
      native.getValueWithKeyAsync.mockRejectedValueOnce(new Error('keychain'));

      const merged = parse(await secureAuthStorage.getItem(KEY));
      expect(merged.state.accessToken).toBeNull();
      expect(merged.state.user).toEqual(user);
    });

    it('setItem stores an unparseable value verbatim in AsyncStorage', async () => {
      await secureAuthStorage.setItem(KEY, '{not json');
      expect(await AsyncStorage.getItem(KEY)).toBe('{not json');
      expect(native.setValueWithKeyAsync).not.toHaveBeenCalled();
    });
  });

  describe('migration from the legacy AsyncStorage-only layout', () => {
    it('moves tokens into SecureStore and scrubs them from AsyncStorage on first read', async () => {
      await AsyncStorage.setItem(KEY, blob({ accessToken: 'legacy-at', refreshToken: 'legacy-rt' }));

      const merged = parse(await secureAuthStorage.getItem(KEY));
      expect(merged.state.accessToken).toBe('legacy-at');
      expect(merged.state.refreshToken).toBe('legacy-rt');
      expect(merged.state.user).toEqual(user);

      expect(await nativeGet(ACCESS_TOKEN_KEY)).toBe('legacy-at');
      expect(await nativeGet(REFRESH_TOKEN_KEY)).toBe('legacy-rt');
      const scrubbed = parse(await AsyncStorage.getItem(KEY));
      expect(scrubbed.state.accessToken).toBeNull();
      expect(scrubbed.state.refreshToken).toBeNull();
      expect(scrubbed.state.user).toEqual(user);

      // Second read is the steady-state path and yields the same session.
      native.setValueWithKeyAsync.mockClear();
      const again = parse(await secureAuthStorage.getItem(KEY));
      expect(again.state.accessToken).toBe('legacy-at');
      expect(native.setValueWithKeyAsync).not.toHaveBeenCalled();
    });

    it('migrates a dev-login session that has only an access token', async () => {
      await AsyncStorage.setItem(KEY, blob({ accessToken: 'dev_x', refreshToken: null }));

      const merged = parse(await secureAuthStorage.getItem(KEY));
      expect(merged.state.accessToken).toBe('dev_x');
      expect(merged.state.refreshToken).toBeNull();
      expect(await nativeGet(ACCESS_TOKEN_KEY)).toBe('dev_x');
      expect(parse(await AsyncStorage.getItem(KEY)).state.accessToken).toBeNull();
    });
  });

  describe('fallback when the native module is missing (old binary)', () => {
    beforeEach(() => {
      mockedNative.mockReturnValue(null);
    });

    it('loadSecureStore returns null and never throws', () => {
      expect(loadSecureStore()).toBeNull();
    });

    it('keeps the whole blob in AsyncStorage and never touches SecureStore', async () => {
      const value = blob({ accessToken: 'at', refreshToken: 'rt' });
      await secureAuthStorage.setItem(KEY, value);

      expect(await AsyncStorage.getItem(KEY)).toBe(value);
      expect(native.setValueWithKeyAsync).not.toHaveBeenCalled();
      expect(await secureAuthStorage.getItem(KEY)).toBe(value);

      await secureAuthStorage.removeItem(KEY);
      expect(await AsyncStorage.getItem(KEY)).toBeNull();
      expect(native.deleteValueWithKeyAsync).not.toHaveBeenCalled();
    });

    it('also falls back when the native module lacks the expected methods', async () => {
      mockedNative.mockReturnValue({ AFTER_FIRST_UNLOCK: 1 });

      expect(loadSecureStore()).toBeNull();
      const value = blob({ accessToken: 'at', refreshToken: 'rt' });
      await secureAuthStorage.setItem(KEY, value);
      expect(await AsyncStorage.getItem(KEY)).toBe(value);
    });

    it('also falls back when the module probe throws', () => {
      mockedNative.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(loadSecureStore()).toBeNull();
    });

    it('caches the probe result', () => {
      mockedNative.mockReturnValue(native);
      expect(loadSecureStore()).toBe(native);
      mockedNative.mockReturnValue(null);
      expect(loadSecureStore()).toBe(native);
      expect(mockedNative).toHaveBeenCalledTimes(1);
    });
  });
});
