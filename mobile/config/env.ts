import Constants from 'expo-constants';

/**
 * Environment configuration
 * Access environment variables through Expo Constants
 */
export const config = {
  apiUrl: Constants.expoConfig?.extra?.apiUrl || (__DEV__ ? 'http://localhost:3000' : 'https://api.capyhoops.com'),
  environment: __DEV__ ? 'development' : 'production',
} as const;
