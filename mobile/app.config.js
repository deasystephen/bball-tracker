const IS_PRODUCTION = process.env.APP_ENV === 'production';
const IS_PREVIEW = process.env.APP_ENV === 'preview';

// Evaluated on the PUBLISHING machine for `eas update`: an unset APP_ENV ships
// the dev host to every device (CLAUDE.md "OTA env gotcha"). The EAS production
// environment provides APP_ENV; `__tests__/app-config.test.ts` pins this mapping.
const PRODUCTION_API_URL = 'https://api.hooplings.com';
const getApiUrl = () => {
  if (IS_PRODUCTION) return process.env.API_URL || PRODUCTION_API_URL;
  if (IS_PREVIEW) return process.env.API_URL || PRODUCTION_API_URL;
  return 'http://127.0.0.1:3000';
};

const getAmplitudeApiKey = () => {
  if (IS_PRODUCTION || IS_PREVIEW) return process.env.AMPLITUDE_API_KEY || '';
  return ''; // Disabled in local development
};

export default {
  expo: {
    name: IS_PRODUCTION ? 'Hooplings' : `Hooplings (${process.env.APP_ENV || 'dev'})`,
    slug: 'bball-tracker',
    // 1.3.0 = OTA runtime boundary for the URL scheme rename (#504). The
    // sign-in redirect scheme is resolved from the OTA MANIFEST (expo-linking
    // reads Constants.expoConfig.scheme), while the schemes a binary answers
    // are baked into Info.plist at build time. A manifest naming `hooplings`
    // must therefore never reach a binary that registers only the old scheme:
    // runtimeVersion policy is appVersion, so bumping this keeps every OTA
    // from here on to 1.3.0 builds (#31+); builds #25-#30 stay on the last
    // 1.2.0 OTA. (1.2.0 was the expo-secure-store boundary, audit #52.)
    version: '1.3.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    // Both schemes are registered natively during the rename overlap (#504):
    // build #31+ still opens old `bball-tracker` deep links (expo-router
    // strips the scheme before routing). Sign-in asks for APP_URL_SCHEME
    // explicitly (config/env.ts), so the order here only decides the dev-only
    // "multiple schemes" warning. The second entry leaves with the first native
    // build cut after 2026-12-01 (dated follow-up).
    scheme: ['hooplings', 'bball-tracker'],
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
      // Hooplings brand navy — matches the icon ground (assets/brand/icon.svg)
      backgroundColor: '#1C2742',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.bballtracker.mobile',
      // Universal Links: pairs with the AASA file served at
      // https://hooplings.com/.well-known/apple-app-site-association (#138).
      // Without this entitlement the AASA is inert and
      // hooplings.com/invite/<token> opens Safari instead of the app
      // (audit #37). Entitlements are native — this rides the next EAS build,
      // an OTA update cannot change it; and it stays inert until the web
      // deploy (#30) serves the apex.
      associatedDomains: ['applinks:hooplings.com'],
      config: {
        usesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        // Hooplings brand navy — the foreground is the transparent capy sticker
        backgroundColor: '#1C2742',
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
      'expo-localization',
      'expo-font',
      'expo-secure-store',
    ],
    extra: {
      apiUrl: getApiUrl(),
      amplitudeApiKey: getAmplitudeApiKey(),
      appEnv: process.env.APP_ENV || 'development',
      // Sentry config — DSN left undefined in local dev so no events ship.
      sentryDsn: process.env.SENTRY_DSN || '',
      sentryEnvironment:
        process.env.SENTRY_ENVIRONMENT || process.env.APP_ENV || 'development',
      sentryRelease: process.env.SENTRY_RELEASE || '',
      eas: {
        projectId: '7b941e92-79aa-4a61-8e79-f2ee9ef67f2f',
      },
    },
  },
};
