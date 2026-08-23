/**
 * Pending post-login return path.
 *
 * Deep links (e.g. `/invite/<token>`) can be opened while logged out. The
 * OAuth round-trip goes through the system browser and comes back via
 * `/auth/callback`, so a query param on `/login` would not survive; instead
 * the originating screen stores the path here and `postLoginRoute` consumes
 * it after a successful sign-in. Entries expire so a path saved weeks ago
 * can't hijack an unrelated login.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const RETURN_PATH_KEY = 'auth:returnPath';
/** How long a stored return path stays valid. */
export const RETURN_PATH_TTL_MS = 30 * 60 * 1000;

interface StoredReturnPath {
  path: string;
  savedAt: number;
}

/** Only in-app absolute paths are accepted (no schemes, no protocol-relative URLs). */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//');
}

export async function setPendingReturnPath(path: string): Promise<void> {
  if (!isSafeReturnPath(path)) return;
  try {
    const entry: StoredReturnPath = { path, savedAt: Date.now() };
    await AsyncStorage.setItem(RETURN_PATH_KEY, JSON.stringify(entry));
  } catch {
    // Best effort: the user simply lands on Home after login.
  }
}

export async function clearPendingReturnPath(): Promise<void> {
  try {
    await AsyncStorage.removeItem(RETURN_PATH_KEY);
  } catch {
    // ignore
  }
}

/**
 * Returns the stored path (and removes it) when present and unexpired,
 * otherwise `null`.
 */
export async function consumePendingReturnPath(now = Date.now()): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(RETURN_PATH_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(RETURN_PATH_KEY);
    const entry = JSON.parse(raw) as Partial<StoredReturnPath>;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.savedAt !== 'number' ||
      !isSafeReturnPath(entry.path) ||
      now - entry.savedAt > RETURN_PATH_TTL_MS
    ) {
      return null;
    }
    return entry.path;
  } catch {
    return null;
  }
}
