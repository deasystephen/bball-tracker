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
 * Mid-session re-auth (#49). The server re-verifies the token it holds for
 * this socket when that token expires. Normal path, no reconnect:
 *   - Whenever the stored access token changes (any `refreshAccessToken()`,
 *     REST-triggered or ours) while connected, this module emits
 *     `refresh-auth { token }` and the server moves the socket onto it.
 *   - While connected it also refreshes PROACTIVE_REFRESH_LEAD_MS before the
 *     token the server holds expires, so a spectator who makes no REST calls
 *     still refreshes in time.
 * Fallback: if no valid token reached the server in time it emits
 * `reauth_required` and closes the transport; socket.io reconnects on its
 * own. If the stored token is already newer than the one the server held and
 * unexpired, the reconnect's auth callback simply carries it; only otherwise
 * is a refresh started (a refresh rotates the WorkOS refresh token, so it is
 * never spent for nothing). A reconnect that wins the race against that
 * refresh is refused `Unauthorized`, and the path above awaits the same
 * single-flight refresh.
 *
 * RN note: pin transport to ['websocket']. The polling fallback works poorly
 * on iOS/Android and adds latency.
 */

import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store/auth-store';
import { refreshAccessToken } from './api-client';
import { getApiUrl } from '../config/env';
import { addBreadcrumb } from './sentry';
import { isTokenUnexpired, tokenExpiresAt } from '../utils/token-expiry';

// Same host as the REST client — decided once in config/env.ts.
const getBaseURL = (): string => getApiUrl();

export const UNAUTHORIZED_MESSAGE = 'Unauthorized';
export const SERVICE_UNAVAILABLE_MESSAGE = 'Service unavailable';
/** Backend socket rate limiter rejected the handshake (audit #16). */
export const RATE_LIMITED_MESSAGE = 'Rate limited';

/** Server → client: the handshake token expired and the connection is closing (#49). */
export const REAUTH_REQUIRED_EVENT = 'reauth_required';
/** Client → server: a fresh access token for the open connection (#49). */
export const REFRESH_AUTH_EVENT = 'refresh-auth';
/** Refresh this long before the server-held token expires (#49). */
export const PROACTIVE_REFRESH_LEAD_MS = 60_000;
/**
 * Never schedule a proactive refresh sooner than this. A device clock ahead of
 * WorkOS by more than (lifetime - lead) would make every new token look
 * nearly expired and loop `/auth/refresh` until WorkOS answered 429.
 */
export const MIN_PROACTIVE_REFRESH_DELAY_MS = 30_000;

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
/** True once this socket has connected at least once, so a later `connect` is a reconnect. */
let hasConnected = false;
/** The token the current handshake carried. */
let handshakeToken: string | null = null;
/**
 * The token the server holds for the open connection: the handshake token,
 * then each token a `refresh-auth` ack accepted. Never set before the ack.
 */
let serverToken: string | null = null;
/** The token a `refresh-auth` is in flight for, so it is not sent twice. */
let pendingToken: string | null = null;
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeAuth: (() => void) | null = null;

/**
 * Socket lifecycle breadcrumbs (#617): connect / reconnect / disconnect and
 * every recovery decision, so a captured error during a live game shows what
 * the connection was doing. Reasons and messages are socket.io's own fixed
 * strings; no URL or token is involved.
 */
const socketCrumb = (message: string, data?: Record<string, unknown>, level: 'info' | 'warning' = 'info'): void => {
  addBreadcrumb({ category: 'socket', message, level, data });
};

const clearRetryTimer = (): void => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const clearProactiveTimer = (): void => {
  if (proactiveTimer) {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
  }
};

/**
 * Refresh ahead of the server-held token's expiry while connected (#49). The
 * single owner of the proactive timer: called on `connect` and when a
 * `refresh-auth` is accepted. The delay is the larger of (remaining lifetime -
 * lead), half the remaining lifetime, and MIN_PROACTIVE_REFRESH_DELAY_MS.
 */
const scheduleProactiveRefresh = (target: Socket): void => {
  clearProactiveTimer();
  const expiresAt = tokenExpiresAt(serverToken);
  if (expiresAt === null) return;
  const remaining = expiresAt - Date.now();
  const delay = Math.max(
    remaining - PROACTIVE_REFRESH_LEAD_MS,
    remaining / 2,
    MIN_PROACTIVE_REFRESH_DELAY_MS
  );
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    if (target !== socket || !target.connected) return;
    socketCrumb('refreshing token ahead of expiry');
    // On `ok` the store changes and the subscription sends `refresh-auth`.
    // Otherwise the server's fallback closes the connection at expiry and the
    // reconnect path recovers.
    void refreshAccessToken();
  }, delay);
};

/**
 * Send the stored access token to the server if it differs from the one the
 * server holds and none is in flight for it. `serverToken` moves only when the
 * server acks success; a refused offer is retried once (unless a newer offer
 * superseded it). Exported for tests; driven by the auth-store subscription
 * and by `connect`.
 */
export function syncSocketToken(target: Socket, allowRetry = true): void {
  if (target !== socket || !target.connected) return;
  const token = useAuthStore.getState().accessToken;
  if (!token || token === serverToken || token === pendingToken) return;
  pendingToken = token;
  target.emit(REFRESH_AUTH_EVENT, { token }, (ack?: { success?: boolean; code?: string }) => {
    if (target !== socket) return;
    if (pendingToken === token) pendingToken = null;
    if (ack?.success) {
      serverToken = token;
      socketCrumb('auth refreshed in-band');
      scheduleProactiveRefresh(target);
      return;
    }
    // The server still holds its previous token; `serverToken` already says so.
    socketCrumb('in-band refresh refused', { code: ack?.code }, 'warning');
    if (allowRetry && ack?.code !== 'superseded') syncSocketToken(target, false);
  });
}

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
      socketCrumb('recovery abandoned: unauthorized', { attempts: authRefreshes }, 'warning');
      recovering = false;
      return;
    }
    authRefreshes += 1;
    recovering = true;
    socketCrumb('recovery: refreshing token', { attempt: authRefreshes });
    const outcome = await refreshAccessToken();
    if (target !== socket) return;
    if (outcome.status === 'ok') {
      target.connect();
      return;
    }
    if (outcome.status === 'unavailable') {
      socketCrumb('recovery: refresh unavailable, backing off', { delayMs: BASE_BACKOFF_MS }, 'warning');
      scheduleReconnect(target, BASE_BACKOFF_MS);
      return;
    }
    // Rejected: the refresh token is dead. The next REST 401 will log the
    // user out (useAuthRedirect → /login); nothing more to do here.
    socketCrumb('recovery abandoned: refresh rejected', undefined, 'warning');
    recovering = false;
    return;
  }

  // `Rate limited` (the backend's per-IP socket limiter, audit #16) recovers
  // the same way as an outage: back off and try again — a middleware
  // rejection is not auto-reconnected by socket.io.
  if (err.message === SERVICE_UNAVAILABLE_MESSAGE || err.message === RATE_LIMITED_MESSAGE) {
    if (unavailableRetries >= MAX_UNAVAILABLE_RETRIES) {
      socketCrumb('recovery abandoned: ' + err.message, { attempts: unavailableRetries }, 'warning');
      recovering = false;
      return;
    }
    const delay = BASE_BACKOFF_MS * 2 ** unavailableRetries;
    unavailableRetries += 1;
    recovering = true;
    socketCrumb('recovery: backing off', { reason: err.message, attempt: unavailableRetries, delayMs: delay });
    scheduleReconnect(target, delay);
    return;
  }

  // Any other handshake error (network) is retried by socket.io itself.
  recovering = false;
}

/**
 * The server is about to close the connection because the handshake token
 * expired. Refresh now so socket.io's automatic reconnect carries a fresh
 * token. Exported for tests; wired to the singleton in `getSocket()`.
 */
export async function handleReauthRequired(target: Socket): Promise<void> {
  if (target !== socket) return;
  recovering = true;
  clearProactiveTimer();
  const stored = useAuthStore.getState().accessToken;
  if (stored && stored !== serverToken && isTokenUnexpired(stored)) {
    // A refresh already landed after the server's copy; the reconnect's auth
    // callback carries it. Spending another rotating refresh token would gain
    // nothing and, on a lossy network, risk losing the session.
    socketCrumb('reauth required: reconnecting with stored token');
    return;
  }
  socketCrumb('reauth required: refreshing token');
  const outcome = await refreshAccessToken();
  if (target !== socket) return;
  if (outcome.status === 'rejected') {
    // The refresh token is dead; the next REST 401 logs the user out.
    socketCrumb('reauth abandoned: refresh rejected', undefined, 'warning');
    recovering = false;
  }
  // `ok`: the reconnect reads the new token. `unavailable`: the reconnect is
  // refused `Unauthorized` and handleConnectError backs off and retries.
}

export function getSocket(): Socket {
  if (socket) return socket;

  const created = io(getBaseURL(), {
    transports: ['websocket'],
    reconnection: true,
    autoConnect: true,
    auth: (cb) => {
      const token = useAuthStore.getState().accessToken;
      handshakeToken = token ?? null;
      cb({ token: token ?? '' });
    },
  });
  socket = created;

  created.on('connect', () => {
    socketCrumb(hasConnected ? 'reconnected' : 'connected', { recovered: created.recovered === true });
    hasConnected = true;
    authRefreshes = 0;
    unavailableRetries = 0;
    recovering = false;
    clearRetryTimer();
    serverToken = handshakeToken;
    pendingToken = null;
    scheduleProactiveRefresh(created);
    // A refresh may have landed while the handshake was in flight.
    syncSocketToken(created);
  });
  created.on('disconnect', (reason: string) => {
    socketCrumb('disconnected', { reason }, 'warning');
    clearProactiveTimer();
    pendingToken = null;
  });
  unsubscribeAuth?.();
  unsubscribeAuth = useAuthStore.subscribe((state) => {
    if (state.accessToken && state.accessToken !== serverToken) syncSocketToken(created);
  });
  created.on(REAUTH_REQUIRED_EVENT, () => {
    void handleReauthRequired(created);
  });
  created.on('connect_error', (err: Error) => {
    socketCrumb('connect_error', { message: err.message }, 'warning');
    void handleConnectError(created, err);
  });

  return created;
}

export function resetSocket(): void {
  clearRetryTimer();
  clearProactiveTimer();
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  handshakeToken = null;
  serverToken = null;
  pendingToken = null;
  authRefreshes = 0;
  unavailableRetries = 0;
  recovering = false;
  hasConnected = false;
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}
