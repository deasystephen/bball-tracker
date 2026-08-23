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

/**
 * Shape of the backend's JSON error body (`utils/errors.ts` + the Express
 * error handler): `{ error: string, code?: string, ...details }`. Some
 * validation paths use `message` instead of `error`.
 */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  code?: string;
  [key: string]: unknown;
}

export interface ApiErrorInfo extends ApiErrorBody {
  status: number;
}

/** An axios error after `normalizeApiError` has run over it. */
export type NormalizedApiError = AxiosError & {
  /** Server `code` (e.g. `upgrade_required`); falls back to axios' own code. */
  code?: string;
  apiError?: ApiErrorInfo;
};

export const UPGRADE_REQUIRED_CODE = 'upgrade_required';

/**
 * Lift the server's error body onto the thrown error so every
 * `error instanceof Error ? error.message : …` site shows the real reason
 * ("Free tier is limited to 3 teams") instead of axios' generic
 * "Request failed with status code 402" (audit #40). Mutates and returns the
 * same object so `instanceof AxiosError` and `error.response` keep working.
 */
export const normalizeApiError = (error: unknown): unknown => {
  if (!isAxiosError(error) || !error.response) return error;
  const status = error.response.status;
  const data = error.response.data;
  if (typeof data !== 'object' || data === null) return error;

  const body = data as ApiErrorBody;
  const normalized = error as NormalizedApiError;
  const message =
    typeof body.error === 'string' && body.error.trim()
      ? body.error
      : typeof body.message === 'string' && body.message.trim()
        ? body.message
        : undefined;

  if (message) normalized.message = message;
  if (typeof body.code === 'string' && body.code) normalized.code = body.code;
  normalized.apiError = { ...body, status };
  return normalized;
};

/** True for a 402 `upgrade_required` response (entitlement / tier cap). */
export const isUpgradeRequiredError = (error: unknown): error is NormalizedApiError => {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  const code = (error as NormalizedApiError).apiError?.code ?? (error as NormalizedApiError).code;
  return status === 402 || code === UPGRADE_REQUIRED_CODE;
};

/** Message to show a user for any thrown value, preferring the server's text. */
export const getApiErrorMessage = (error: unknown, fallback: string): string => {
  if (isAxiosError(error)) {
    const info = (error as NormalizedApiError).apiError;
    if (info?.error) return info.error;
    if (typeof info?.message === 'string' && info.message) return info.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

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

  // Normalize server error bodies first (runs before the auth interceptor
  // below, so a 401's message is also readable if it is surfaced).
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(normalizeApiError(error))
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
