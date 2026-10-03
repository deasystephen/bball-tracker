import { create as createAxiosInstance, AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore, getLogoutEpoch } from '../store/auth-store';
import { getApiUrl } from '../config/env';
import { NO_SESSION_CODE, NoSessionError, isNoSessionError } from './no-session-error';
import { addBreadcrumb, captureException, endpointPattern } from './sentry';

/**
 * API client configuration. The base URL is decided in one place,
 * `config/env.ts#getApiUrl()` (extra.apiUrl from app.config.js, else the dev
 * server under __DEV__, else the production API).
 */
const getBaseURL = (): string => getApiUrl();

/**
 * Auth endpoints whose own 401 means "re-login required" — never try to
 * refresh on their behalf, or a rejected refresh token would loop forever.
 */
const NO_REFRESH_PATHS = ['/auth/refresh', '/auth/callback', '/auth/login', '/auth/dev-login'];

const isNoRefreshPath = (url?: string): boolean =>
  !!url && NO_REFRESH_PATHS.some((p) => url.startsWith(p) || url.includes(`/api/v1${p}`));

/**
 * The only endpoints a signed-out app may call. Everything else needs a
 * session, and is refused locally when there is none (see `NoSessionError`).
 *
 * A new unauthenticated endpoint MUST be added here, or it will never be sent
 * from the sign-in and invite screens. `__tests__/services/api-client.test.ts`
 * pins the list.
 */
export const PUBLIC_PATHS = [
  ...NO_REFRESH_PATHS,
  '/auth/dev-users',
  '/invitations/by-token/',
];

const isPublicPath = (url?: string): boolean =>
  !!url && PUBLIC_PATHS.some((p) => url.startsWith(p) || url.includes(`/api/v1${p}`));

export { NO_SESSION_CODE, NoSessionError, isNoSessionError };

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean; _startedAt?: number };

/** Route pattern for a request config: base URL + url, redacted and id-collapsed. */
const configPattern = (config?: Pick<InternalAxiosRequestConfig, 'baseURL' | 'url'>): string => {
  if (!config?.url) return '';
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(config.url);
  return endpointPattern(absolute || !config.baseURL ? config.url : `${config.baseURL}${config.url}`);
};

const configMethod = (config?: Pick<InternalAxiosRequestConfig, 'method'>): string =>
  (config?.method ?? 'get').toUpperCase();

const elapsed = (config?: RetriableConfig): number | undefined =>
  config?._startedAt === undefined ? undefined : Date.now() - config._startedAt;

/** Axios' own cancellation (`ERR_CANCELED`) is the caller's doing, never an incident. */
const isCancellation = (error: AxiosError): boolean => error.code === 'ERR_CANCELED';

/**
 * `NoSessionError` is reported once per endpoint pattern per session end
 * (#582 showed one screen can retry the same request dozens of times after
 * sign-out): the first refusal of each pattern since the last logout is
 * captured, the rest only leave a breadcrumb. `getLogoutEpoch` increments on
 * every session end, so the next sign-out reports again.
 */
const noSessionReported = new Map<string, number>();

const reportNoSession = (error: NoSessionError, pattern: string): void => {
  const epoch = getLogoutEpoch();
  if (noSessionReported.get(pattern) === epoch) return;
  noSessionReported.set(pattern, epoch);
  captureException(error, { endpoint: pattern }, { endpoint_pattern: pattern, status: 'no_session' });
};

/**
 * Observability interceptor (#617): a breadcrumb for every request (method,
 * redacted route pattern, status, duration) and a captured exception for
 * what the user cannot act on — a network failure or a 5xx. 4xx answers are
 * the user's own outcome (403, 404, validation) and are breadcrumbs only.
 * Everything passes through `endpointPattern`, so no token, OAuth code or
 * email reaches Sentry.
 */
export const observeResponse = (response: AxiosResponse): AxiosResponse => {
  const config = response.config as RetriableConfig | undefined;
  addBreadcrumb({
    category: 'http',
    type: 'http',
    data: {
      method: configMethod(config),
      url: configPattern(config),
      status_code: response.status,
      duration: elapsed(config),
    },
  });
  return response;
};

export const observeError = (error: unknown): Promise<never> => {
  if (isNoSessionError(error)) {
    const pattern = configPattern(error.config);
    addBreadcrumb({
      category: 'http',
      type: 'http',
      level: 'warning',
      data: { method: configMethod(error.config), url: pattern, reason: NO_SESSION_CODE },
    });
    reportNoSession(error, pattern);
  } else if (isAxiosError(error)) {
    const config = error.config as RetriableConfig | undefined;
    const pattern = configPattern(config);
    const status = error.response?.status;
    addBreadcrumb({
      category: 'http',
      type: 'http',
      level: status === undefined || status >= 500 ? 'error' : 'warning',
      data: {
        method: configMethod(config),
        url: pattern,
        status_code: status,
        duration: elapsed(config),
        ...(status === undefined ? { reason: error.code ?? 'network' } : {}),
      },
    });
    if (status === undefined && !isCancellation(error)) {
      captureException(
        error,
        { endpoint: pattern, code: error.code },
        { endpoint_pattern: pattern, status: 'network' }
      );
    } else if (status !== undefined && status >= 500) {
      captureException(error, { endpoint: pattern }, { endpoint_pattern: pattern, status });
    }
  }
  return Promise.reject(error);
};

/** True when the request went out carrying a bearer token. */
const sentWithToken = (config?: RetriableConfig): boolean => {
  const headers = config?.headers as
    | { Authorization?: unknown; get?: (name: string) => unknown }
    | undefined;
  if (!headers) return false;
  const value = typeof headers.get === 'function' ? headers.get('Authorization') : headers.Authorization;
  return typeof value === 'string' && value.length > 0;
};

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
 * (e.g. "You do not have permission to create teams in this league") instead
 * of axios' generic "Request failed with status code 403" (audit #40). Mutates and returns the
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
      (config as RetriableConfig)._startedAt = Date.now();
      const token = useAuthStore.getState().accessToken;
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
        return config;
      }
      // No session: a request that needs one is never sent (#582).
      if (!isPublicPath(config.url)) {
        return Promise.reject(new NoSessionError(config));
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

  // Breadcrumbs + error capture (#617). After normalization so the captured
  // error carries the server's message; before the 401 handler so a refresh
  // and replay shows up as two crumbs.
  client.interceptors.response.use(observeResponse, observeError);

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

      // Sent without a token (a public endpoint that answered 401): there was
      // no session behind this request, so there is none to refresh and none
      // to end (#582).
      if (!sentWithToken(original)) {
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
