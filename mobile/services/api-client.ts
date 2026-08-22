import { create as createAxiosInstance, AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import Constants from 'expo-constants';
import { useAuthStore } from '../store/auth-store';

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
 * Single-flight refresh. When several requests 401 at once (e.g. Home firing
 * teams + games + invitations after the app returns from background with an
 * expired token) they all await the same refresh call; WorkOS rotates the
 * refresh token on every use, so firing it in parallel would invalidate all
 * but the first.
 */
let refreshInFlight: Promise<string | null> | null = null;

const refreshAccessToken = (client: AxiosInstance): Promise<string | null> => {
  if (refreshInFlight) return refreshInFlight;

  const { refreshToken, setAuthToken } = useAuthStore.getState();
  if (!refreshToken) return Promise.resolve(null);

  refreshInFlight = client
    .post<RefreshResponse>('/auth/refresh', { refreshToken })
    .then((res) => {
      setAuthToken(res.data.accessToken, res.data.refreshToken);
      return res.data.accessToken;
    })
    .catch(() => null)
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

      // Expired access token: refresh once and replay the original request.
      const original = error.config as RetriableConfig | undefined;
      if (original && !original._retry && !isNoRefreshPath(original.url)) {
        original._retry = true;
        const newToken = await refreshAccessToken(client);
        if (newToken) {
          original.headers.Authorization = `Bearer ${newToken}`;
          return client.request(original);
        }
      }

      // No refresh token, refresh rejected, or the retry itself 401'd:
      // the session is gone. Clearing auth triggers useAuthRedirect → /login.
      useAuthStore.getState().logout();
      return Promise.reject(error);
    }
  );

  return client;
};

export const apiClient = createApiClient();
