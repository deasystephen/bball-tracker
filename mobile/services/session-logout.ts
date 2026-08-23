/**
 * Logout side effects (audit #17, #18, #19, #41).
 *
 * The auth store owns the *state* of a session; this module owns everything
 * else that must happen when one ends. It registers itself with the store's
 * `session-hooks` registry on load (imported for that side effect from
 * `app/_layout.tsx`), so the store never imports the api-client, which
 * itself imports the store.
 *
 *  Remote (best-effort, while the access token is still valid):
 *   1. `DELETE /auth/push-token` for the token this device registered, so a
 *      signed-out phone stops receiving team announcements (#18, E2E N.4).
 *   2. `POST /auth/logout` to revoke the WorkOS session + refresh token.
 *  Local:
 *   3. `resetSocket()` — the live-game socket pins the user at handshake; the
 *      next user must not inherit it (#17).
 *   4. `queryClient.clear()` — query keys are not user-scoped (#19).
 *
 * Remote failures (offline, expired token, 404 on an older backend) never
 * block the local sign-out: the user asked to leave, so they leave.
 */

import { apiClient } from './api-client';
import { queryClient } from './query-client';
import { resetSocket } from './socket';
import { unregisterPushToken } from '../hooks/useNotifications';
import { setSessionHooks } from '../store/session-hooks';

/** Per-call cap so an offline logout does not hang on the 10s client timeout twice. */
export const LOGOUT_REQUEST_TIMEOUT_MS = 4000;

export async function runRemoteLogout(): Promise<void> {
  try {
    await unregisterPushToken(LOGOUT_REQUEST_TIMEOUT_MS);
  } catch {
    // Best-effort; the token is also pruned server-side on delivery failure.
  }
  try {
    await apiClient.post('/auth/logout', undefined, { timeout: LOGOUT_REQUEST_TIMEOUT_MS });
  } catch {
    // Best-effort; local sign-out proceeds regardless.
  }
}

export function runLocalLogoutCleanup(): void {
  resetSocket();
  queryClient.clear();
}

setSessionHooks({ remoteLogout: runRemoteLogout, localCleanup: runLocalLogoutCleanup });
