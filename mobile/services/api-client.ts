import { create as createAxiosInstance, AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import Constants from 'expo-constants';
import { useAuthStore, getLogoutEpoch } from '../store/auth-store';

/**
 * API client configuration
 * Base URL comes from app.config.js which sets it per build profile:
 *   development: http://127.0.0.1:3000
 *   preview/production: https://api.capyhoops.com (or API_URL env var)
 */
const getBaseURL = (): string => {
  return Constants.expoConfig?.extra?.apiUrl || (__DEV__ ? 'http://127.0.0.1:3000' : 'https://api.capyhoops.com');
};

/**
 * Auth endpoints whose own 401 means "re-login required" — never try to
 * refresh on their behalf, or a rejected refresh token would loop forever.
 */
const NO_REFRESH_PATHS = ['/auth/refresh', '/auth/callback', '/auth/login', '/auth/dev-login'];

const isNoRefreshPath = (url?: string): boolean =>
  !!url && NO_REFRESH_PATHS.some((p) => url.startsWith(p) || url.includes(`/api/v1${p}`));

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/**
 * Outcome of a refresh attempt.
 *  - `ok`: new access token stored and returned.
 *  - `rejected`: the server said the refresh token is invalid (401) or there
 *    is none to send — the session is gone and the caller should log out.
 *  - `unavailable`: the refresh could not be completed (network error,
 *    timeout, 5xx/503, 429). The stored tokens are still valid as far as we
 *    know, so callers must NOT log out; surface the error and let the user
 *    retry (audit #20).
 */
export type RefreshOutcome =
  | { status: 'ok'; accessToken: string }
  | { status: 'rejected' }
  | { status: 'unavailable'; error: unknown };

const isAxiosError = (err: unknown): err is AxiosError =>
  typeof err === 'object' && err !== null && 'isAxiosError' in err && (err as AxiosError).isAxiosError === true;

/** True only for a definitive "this refresh token is no good" answer. */
const isRefreshRejection = (err: unknown): boolean => {
  const status = isAxiosError(err)
    ? err.response?.status
    : (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 401;
};

/**
 * Single-flight refresh. When several requests 401 at once (e.g. Home firing
 * teams + games + invitations after the app returns from background with an
 * expired token) they all await the same refresh call; WorkOS rotates the
 * refresh token on every use, so firing it in parallel would invalidate all
 * but the first.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

export const refreshAccessToken = (client: AxiosInstance = apiClient): Promise<RefreshOutcome> => {
  if (refreshInFlight) return refreshInFlight;

  const { refreshToken, setAuthToken } = useAuthStore.getState();
  if (!refreshToken) return Promise.resolve({ status: 'rejected' });
  const epoch = getLogoutEpoch();

  refreshInFlight = client
    .post<RefreshResponse>('/auth/refresh', { refreshToken })
    .then((res): RefreshOutcome => {
      // The user signed out while this was in flight: do not resurrect the
      // session with the new pair (audit #41).
      if (getLogoutEpoch() !== epoch) return { status: 'rejected' };
      setAuthToken(res.data.accessToken, res.data.refreshToken);
      return { status: 'ok', accessToken: res.data.accessToken };
    })
    .catch((err: unknown): RefreshOutcome => {
      if (isRefreshRejection(err)) return { status: 'rejected' };
      return { status: 'unavailable', error: err };
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
};

/**
 * Create axios instance with default configuration
 */
const createApiClient = (): AxiosInstance => {
  const client = createAxiosInstance({
    baseURL: `${getBaseURL()}/api/v1`,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  // Add request interceptor to include auth token
  client.interceptors.request.use(
    (config) => {
      const token = useAuthStore.getState().accessToken;
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Add response interceptor to handle errors
  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      if (error.response?.status !== 401) {
        return Promise.reject(error);
      }

      const original = error.config as RetriableConfig | undefined;

      // A 401 from an auth endpoint is that endpoint's own business (a
      // rejected refresh is handled by refreshAccessToken's caller; a failed
      // login/callback never had a session to end). Never log out here.
      if (original && isNoRefreshPath(original.url)) {
        return Promise.reject(error);
      }

      // Expired access token: refresh once and replay the original request.
      if (original && !original._retry) {
        original._retry = true;
        const outcome = await refreshAccessToken(client);
        if (outcome.status === 'ok') {
          original.headers.Authorization = `Bearer ${outcome.accessToken}`;
          return client.request(original);
        }
        if (outcome.status === 'unavailable') {
          // Transient: keep the session, surface the failure to the caller.
          return Promise.reject(error);
        }
      }

      // No refresh token, refresh token rejected, or the retry itself 401'd:
      // the session is gone. Local clear only (no network — the token is
      // dead); it triggers useAuthRedirect → /login.
      useAuthStore.getState().clearSession();
      return Promise.reject(error);
    }
  );

  return client;
};

export const apiClient = createApiClient();
