import axios, { AxiosInstance, AxiosError } from 'axios';
import Constants from 'expo-constants';
import { useAuthStore } from '../store/auth-store';

/**
 * API client configuration
 * Base URL comes from app.config.js which sets it per build profile:
 *   development: http://127.0.0.1:3000
 *   preview/production: https://api.capyhoops.com (or API_URL env var)
 */
const getBaseURL = (): string => {
  return Constants.expoConfig?.extra?.apiUrl || 'http://127.0.0.1:3000';
};

/**
 * Create axios instance with default configuration
 */
const createApiClient = (): AxiosInstance => {
  const client = axios.create({
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
    (error: AxiosError) => {
      // Handle 401 Unauthorized - clear auth and redirect to login
      if (error.response?.status === 401) {
        useAuthStore.getState().logout();
      }
      return Promise.reject(error);
    }
  );

  return client;
};

export const apiClient = createApiClient();
