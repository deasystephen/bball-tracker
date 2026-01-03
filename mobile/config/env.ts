import Constants from 'expo-constants';

/**
 * Environment configuration
 * Access environment variables through Expo Constants
 */
export const config = {
  apiUrl: Constants.expoConfig?.extra?.apiUrl || 'http://localhost:3000',
  environment: __DEV__ ? 'development' : 'production',
} as const;
