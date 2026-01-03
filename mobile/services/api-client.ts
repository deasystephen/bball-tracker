import axios, { AxiosInstance, AxiosError } from 'axios';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useAuthStore } from '../store/auth-store';

/**
 * API client configuration
 * Base URL is determined from environment or defaults to localhost
 * 
 * Note: iOS Simulator requires 127.0.0.1 instead of localhost
 */
const getBaseURL = (): string => {
  // In development, use localhost
  // In production, this would come from environment variables
  const apiUrl = Constants.expoConfig?.extra?.apiUrl;
  if (apiUrl) {
    return apiUrl;
  }
  
  // Default to localhost for development
  if (__DEV__) {
    // iOS Simulator needs 127.0.0.1 instead of localhost
    // Android Emulator can use localhost or 10.0.2.2
    if (Platform.OS === 'ios') {
      return 'http://127.0.0.1:3000';
    }
    return 'http://localhost:3000';
  }
  
  return 'https://api.bball-tracker.com';
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
