const IS_PRODUCTION = process.env.APP_ENV === 'production';
const IS_PREVIEW = process.env.APP_ENV === 'preview';

const getApiUrl = () => {
  if (IS_PRODUCTION) return process.env.API_URL || 'https://api.bball-tracker.com';
  if (IS_PREVIEW) return process.env.API_URL || 'https://api.bball-tracker.com';
  return 'http://127.0.0.1:3000';
};

const getAmplitudeApiKey = () => {
  if (IS_PRODUCTION || IS_PREVIEW) return process.env.AMPLITUDE_API_KEY || '';
  return ''; // Disabled in local development
};

export default {
  expo: {
    name: IS_PRODUCTION ? 'Basketball Tracker' : `Basketball Tracker (${process.env.APP_ENV || 'dev'})`,
    slug: 'bball-tracker',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    scheme: 'bball-tracker',
    owner: 'deasystephen',
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/7b941e92-79aa-4a61-8e79-f2ee9ef67f2f',
    },
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#1A3A5C',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.bballtracker.mobile',
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#ffffff',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: 'com.bballtracker.mobile',
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-router',
    ],
    extra: {
      apiUrl: getApiUrl(),
      amplitudeApiKey: getAmplitudeApiKey(),
      eas: {
        projectId: '7b941e92-79aa-4a61-8e79-f2ee9ef67f2f',
      },
    },
  },
};
