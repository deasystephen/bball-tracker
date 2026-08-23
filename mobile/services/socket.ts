/**
 * Socket.io client singleton.
 *
 * One persistent connection per app launch. Lazily constructed on first
 * `getSocket()` call. The auth token is supplied via a callback so reconnects
 * pick up a rotated token without recreating the socket.
 *
 * Handshake failures (audit #17b): a server-side middleware rejection arrives
 * as `connect_error` and — unlike a transport drop — socket.io does NOT
 * auto-reconnect from it. So this module owns recovery:
 *   - `Unauthorized` (expired access token, e.g. app backgrounded >10 min
 *     mid-game): refresh through the api-client's single-flight refresh, then
 *     `socket.connect()` again (the auth callback reads the new token). Capped
 *     at MAX_AUTH_REFRESHES consecutive attempts; a rejected refresh token is
 *     left to the next REST call, which logs the user out.
 *   - `Service unavailable` (backend cannot reach WorkOS/JWKS, #352): back off
 *     exponentially and reconnect, capped at MAX_UNAVAILABLE_RETRIES.
 * A successful `connect` resets both counters.
 *
 * RN note: pin transport to ['websocket']. The polling fallback works poorly
 * on iOS/Android and adds latency.
 */

import Constants from 'expo-constants';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store/auth-store';
import { refreshAccessToken } from './api-client';

const getBaseURL = (): string => {
  return (
    Constants.expoConfig?.extra?.apiUrl ||
    (__DEV__ ? 'http://127.0.0.1:3000' : 'https://api.capyhoops.com')
  );
};

export const UNAUTHORIZED_MESSAGE = 'Unauthorized';
export const SERVICE_UNAVAILABLE_MESSAGE = 'Service unavailable';
/** Backend socket rate limiter rejected the handshake (audit #16). */
export const RATE_LIMITED_MESSAGE = 'Rate limited';

/** Consecutive `Unauthorized` handshakes we will try to refresh through. */
export const MAX_AUTH_REFRESHES = 2;
/** Consecutive `Service unavailable` handshakes we will back off and retry. */
export const MAX_UNAVAILABLE_RETRIES = 5;
/** First back-off delay; doubles per retry (2s, 4s, 8s, 16s, 32s). */
export const BASE_BACKOFF_MS = 2000;

let socket: Socket | null = null;
let authRefreshes = 0;
let unavailableRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let recovering = false;

const clearRetryTimer = (): void => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const scheduleReconnect = (target: Socket, delayMs: number): void => {
  clearRetryTimer();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // Ignore if the singleton was reset (logout) while we were waiting.
    if (target !== socket) return;
    target.connect();
  }, delayMs);
};

/**
 * True while this module is actively trying to recover from a handshake
 * rejection (refreshing the token or waiting out a back-off). Consumers use
 * it to show "reconnecting" rather than a terminal error.
 */
export function isSocketRecovering(): boolean {
  return recovering;
}

/**
 * Recovery for a `connect_error`. Exported for tests; wired to the singleton
 * in `getSocket()`. Returns once the recovery decision (and any token refresh)
 * has completed — the actual reconnect may still be pending on a timer.
 */
export async function handleConnectError(target: Socket, err: Error): Promise<void> {
  if (target !== socket) return;

  if (err.message === UNAUTHORIZED_MESSAGE) {
    if (authRefreshes >= MAX_AUTH_REFRESHES) {
      recovering = false;
      return;
    }
    authRefreshes += 1;
    recovering = true;
    const outcome = await refreshAccessToken();
    if (target !== socket) return;
    if (outcome.status === 'ok') {
      target.connect();
      return;
    }
    if (outcome.status === 'unavailable') {
      scheduleReconnect(target, BASE_BACKOFF_MS);
      return;
    }
    // Rejected: the refresh token is dead. The next REST 401 will log the
    // user out (useAuthRedirect → /login); nothing more to do here.
    recovering = false;
    return;
  }

  // `Rate limited` (the backend's per-IP socket limiter, audit #16) recovers
  // the same way as an outage: back off and try again — a middleware
  // rejection is not auto-reconnected by socket.io.
  if (err.message === SERVICE_UNAVAILABLE_MESSAGE || err.message === RATE_LIMITED_MESSAGE) {
    if (unavailableRetries >= MAX_UNAVAILABLE_RETRIES) {
      recovering = false;
      return;
    }
    const delay = BASE_BACKOFF_MS * 2 ** unavailableRetries;
    unavailableRetries += 1;
    recovering = true;
    scheduleReconnect(target, delay);
    return;
  }

  // Any other handshake error (network) is retried by socket.io itself.
  recovering = false;
}

export function getSocket(): Socket {
  if (socket) return socket;

  const created = io(getBaseURL(), {
    transports: ['websocket'],
    reconnection: true,
    autoConnect: true,
    auth: (cb) => {
      const token = useAuthStore.getState().accessToken;
      cb({ token: token ?? '' });
    },
  });
  socket = created;

  created.on('connect', () => {
    authRefreshes = 0;
    unavailableRetries = 0;
    recovering = false;
    clearRetryTimer();
  });
  created.on('connect_error', (err: Error) => {
    void handleConnectError(created, err);
  });

  return created;
}

export function resetSocket(): void {
  clearRetryTimer();
  authRefreshes = 0;
  unavailableRetries = 0;
  recovering = false;
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}
