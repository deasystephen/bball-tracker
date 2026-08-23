/**
 * Split persistence adapter for the auth store (audit #52).
 *
 * Zustand `persist` serialises the whole auth blob
 * (`{ state: { accessToken, refreshToken, user, isAuthenticated }, version }`)
 * into one string. Before #52 that string — two WorkOS JWTs included — sat in
 * plaintext AsyncStorage, which is readable by anything with filesystem
 * access to the app sandbox (backups, jailbroken devices, forensic tools).
 *
 * This adapter keeps the Zustand contract (`getItem` / `setItem` /
 * `removeItem` on the single `auth-storage` key) but splits where the bytes
 * go:
 *
 *   SecureStore (iOS Keychain / Android Keystore, `AFTER_FIRST_UNLOCK`):
 *     `auth.accessToken`   the WorkOS access JWT
 *     `auth.refreshToken`  the rotating WorkOS refresh token
 *   AsyncStorage:
 *     `auth-storage`       the rest of the blob (user, isAuthenticated, version)
 *                          with both token fields rewritten to `null`
 *
 * Tokens live in two separate SecureStore entries because iOS caps each value
 * at 2048 bytes; a JWT plus the user object would not fit in one.
 *
 * Fallback: `expo-secure-store` is a **native** module that first shipped in
 * the 1.2.0 binary (build #25). A JS bundle that somehow reaches an older
 * binary must not crash at import time — and `import 'expo-secure-store'`
 * would, because its wrapper calls `requireNativeModule` at module load. So
 * this file never imports the wrapper; it probes the native module with
 * `requireOptionalNativeModule('ExpoSecureStore')` and calls the same
 * methods the wrapper does (`getValueWithKeyAsync` / `setValueWithKeyAsync`
 * / `deleteValueWithKeyAsync`, see expo-secure-store/build/SecureStore.js —
 * the package is pinned by the Expo SDK and on the dependabot ignore list).
 * When the module is missing, or lacks those methods, the adapter degrades to
 * the pre-#52 behaviour and keeps the whole blob in AsyncStorage.
 *
 * Migration: on the first `getItem` after upgrading from a 1.1.0 build the
 * legacy AsyncStorage blob still contains tokens. They are moved into
 * SecureStore and the AsyncStorage copy is rewritten without them, so the
 * user stays signed in across the upgrade and the plaintext copy is gone
 * after the first launch.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import type { StateStorage } from 'zustand/middleware';

export const ACCESS_TOKEN_KEY = 'auth.accessToken';
export const REFRESH_TOKEN_KEY = 'auth.refreshToken';

/** Keychain accessibility option name, as expo-secure-store's `SecureStoreOptions`. */
interface SecureStoreOptions {
  keychainAccessible?: number;
}

/** The subset of the `ExpoSecureStore` native module this adapter uses. */
export interface SecureStoreNative {
  AFTER_FIRST_UNLOCK?: number;
  getValueWithKeyAsync(key: string, options: SecureStoreOptions): Promise<string | null>;
  setValueWithKeyAsync(value: string, key: string, options: SecureStoreOptions): Promise<void>;
  deleteValueWithKeyAsync(key: string, options: SecureStoreOptions): Promise<void>;
}

interface TokenPair {
  accessToken: string | null;
  refreshToken: string | null;
}

interface PersistedBlob {
  state?: Record<string, unknown> & Partial<TokenPair>;
  version?: number;
}

const NO_TOKENS: TokenPair = { accessToken: null, refreshToken: null };

let cached: SecureStoreNative | null | undefined;

function isSecureStoreNative(candidate: unknown): candidate is SecureStoreNative {
  if (!candidate || typeof candidate !== 'object') return false;
  const mod = candidate as Record<string, unknown>;
  return (
    typeof mod.getValueWithKeyAsync === 'function' &&
    typeof mod.setValueWithKeyAsync === 'function' &&
    typeof mod.deleteValueWithKeyAsync === 'function'
  );
}

/**
 * Resolve the SecureStore native module once, or `null` when it is not
 * compiled into this binary. Never throws.
 */
export function loadSecureStore(): SecureStoreNative | null {
  if (cached === undefined) {
    try {
      const mod: unknown = requireOptionalNativeModule('ExpoSecureStore');
      cached = isSecureStoreNative(mod) ? mod : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Test hook: forget the cached module so the next call re-probes. */
export function resetSecureStoreCacheForTests(): void {
  cached = undefined;
}

function secureOptions(mod: SecureStoreNative): SecureStoreOptions {
  return mod.AFTER_FIRST_UNLOCK === undefined ? {} : { keychainAccessible: mod.AFTER_FIRST_UNLOCK };
}

async function readTokens(mod: SecureStoreNative): Promise<TokenPair> {
  const read = async (key: string): Promise<string | null> => {
    try {
      return (await mod.getValueWithKeyAsync(key, secureOptions(mod))) ?? null;
    } catch {
      // A corrupt/unreadable keychain entry must behave like "no token".
      return null;
    }
  };
  const [accessToken, refreshToken] = await Promise.all([
    read(ACCESS_TOKEN_KEY),
    read(REFRESH_TOKEN_KEY),
  ]);
  return { accessToken, refreshToken };
}

async function writeToken(mod: SecureStoreNative, key: string, value: string | null) {
  if (value) {
    await mod.setValueWithKeyAsync(value, key, secureOptions(mod));
  } else {
    await mod.deleteValueWithKeyAsync(key, secureOptions(mod));
  }
}

async function writeTokens(mod: SecureStoreNative, tokens: TokenPair): Promise<void> {
  await Promise.all([
    writeToken(mod, ACCESS_TOKEN_KEY, tokens.accessToken),
    writeToken(mod, REFRESH_TOKEN_KEY, tokens.refreshToken),
  ]);
}

function parseBlob(raw: string | null): PersistedBlob | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PersistedBlob) : null;
  } catch {
    return null;
  }
}

function tokensOf(blob: PersistedBlob): TokenPair {
  return {
    accessToken: blob.state?.accessToken ?? null,
    refreshToken: blob.state?.refreshToken ?? null,
  };
}

function withTokens(blob: PersistedBlob, tokens: TokenPair): string {
  return JSON.stringify({ ...blob, state: { ...blob.state, ...tokens } });
}

function hasTokens(blob: PersistedBlob | null): boolean {
  return Boolean(blob?.state?.accessToken || blob?.state?.refreshToken);
}

/**
 * `StateStorage` for Zustand's `createJSONStorage`. Keyed by the persist
 * `name` for the AsyncStorage half; the SecureStore half always uses the two
 * fixed keys above (there is exactly one auth session per device).
 */
export const secureAuthStorage: StateStorage = {
  async getItem(name: string): Promise<string | null> {
    const raw = await AsyncStorage.getItem(name);
    const mod = loadSecureStore();
    if (!mod) {
      // Old binary: whole blob (tokens included) lives in AsyncStorage.
      return raw;
    }

    const blob = parseBlob(raw);
    if (blob && hasTokens(blob)) {
      // One-time migration from the pre-#52 layout: move the plaintext
      // tokens into the keychain, then scrub them from AsyncStorage.
      const legacy = tokensOf(blob);
      await writeTokens(mod, legacy);
      await AsyncStorage.setItem(name, withTokens(blob, NO_TOKENS));
      return withTokens(blob, legacy);
    }

    const tokens = await readTokens(mod);
    if (!blob) {
      // Nothing persisted (fresh install, or AsyncStorage was cleared).
      // Orphaned keychain tokens without a user are useless — drop them.
      if (tokens.accessToken || tokens.refreshToken) await writeTokens(mod, NO_TOKENS);
      return raw;
    }
    return withTokens(blob, tokens);
  },

  async setItem(name: string, value: string): Promise<void> {
    const mod = loadSecureStore();
    const blob = parseBlob(value);
    if (!mod || !blob) {
      await AsyncStorage.setItem(name, value);
      return;
    }
    await writeTokens(mod, tokensOf(blob));
    await AsyncStorage.setItem(name, withTokens(blob, NO_TOKENS));
  },

  async removeItem(name: string): Promise<void> {
    await AsyncStorage.removeItem(name);
    const mod = loadSecureStore();
    if (mod) await writeTokens(mod, NO_TOKENS);
  },
};

/**
 * Wipe both halves. Called from `clearSession()` so a sign-out never leaves a
 * token in the keychain even if Zustand's own `setItem` of the cleared state
 * were to fail.
 */
export async function clearPersistedAuth(name: string): Promise<void> {
  await secureAuthStorage.removeItem(name);
}
