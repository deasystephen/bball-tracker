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

// iOS permission purpose strings (#451). App Review rejects generic purpose
// strings, and the Expo config plugins fall back to boilerplate ("Allow
// $(PRODUCT_NAME) to access your camera") when none is given. The camera and
// the photo library are used for ONE thing: picking a profile photo, for the
// signed-in user (Profile) or for a player a coach adds to a roster
// (components/AvatarPicker.tsx -> services/upload-service.ts). Keep these
// strings true to that; `__tests__/app-config.test.ts` pins them.
// Baked into Info.plist at build time: they ship with the next `eas build`,
// an OTA cannot change them.
const CAMERA_PURPOSE =
  'Hooplings uses your camera to take a profile photo for you or for a player on your team roster.';
const PHOTOS_PURPOSE =
  'Hooplings uses your photo library so you can choose a profile photo for yourself or for a player on your team roster.';

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
    // URL scheme (#504). Sign-in asks for APP_URL_SCHEME explicitly
    // (config/env.ts) rather than reading this value, because the OTA manifest
    // carries it while the schemes a binary answers are baked into Info.plist.
    // The pre-rename scheme left the array in #513; build #31 still
    // registers it natively until its successor is cut.
    scheme: 'hooplings',
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
      // The app never asks for biometric unlock (services/secure-storage.ts
      // passes only `keychainAccessible`, never `requireAuthentication`), so
      // the plugin's default NSFaceIDUsageDescription would declare a
      // capability the app does not use (#451). `false` removes the key.
      ['expo-secure-store', { faceIDPermission: false }],
      // Listed explicitly so the purpose strings are ours: prebuild applies
      // this plugin with its boilerplate defaults when it is absent. The
      // picker is images-only (`mediaTypes: ['images']`), so no audio is ever
      // recorded: `microphonePermission: false` drops
      // NSMicrophoneUsageDescription on iOS and blocks RECORD_AUDIO on Android.
      [
        'expo-image-picker',
        {
          cameraPermission: CAMERA_PURPOSE,
          photosPermission: PHOTOS_PURPOSE,
          microphonePermission: false,
        },
      ],
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
