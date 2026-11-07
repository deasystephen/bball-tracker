// On an EAS build worker every profile in eas.json sets APP_ENV; a profile
// that forgot it would bake the dev host into a binary (#721). Fail the build
// instead. `eas update` sets no such variable, so the runtime guard in
// config/env.ts#getApiUrl() is what protects an OTA.
if (process.env.EAS_BUILD === 'true' && !process.env.APP_ENV) {
  throw new Error(
    'app.config.js: APP_ENV is unset on an EAS build. Set APP_ENV in the build profile (eas.json) so the binary gets the right API host.'
  );
}

const IS_PRODUCTION = process.env.APP_ENV === 'production';
const IS_PREVIEW = process.env.APP_ENV === 'preview';

// Evaluated on the PUBLISHING machine for `eas update`: an unset APP_ENV ships
// the dev host (docs/deployment/mobile-builds-and-ota.md "OTA env gotcha"),
// which release bundles ignore in favour of the production API (#721,
// config/env.ts#getApiUrl). The EAS production environment provides APP_ENV;
// `__tests__/app-config.test.ts` pins this mapping.
const PRODUCTION_API_URL = 'https://api.hooplings.com';
const getApiUrl = () => {
  if (IS_PRODUCTION) return process.env.API_URL || PRODUCTION_API_URL;
  if (IS_PREVIEW) return process.env.API_URL || PRODUCTION_API_URL;
  // A local Release build (APP_ENV unset) ignores the loopback default at
  // runtime and calls production (#721); LOCAL_API_URL=http://<lan-ip>:3000
  // points it at a development backend on purpose. Deliberately not API_URL:
  // an API_URL exported in a shell must never reach an OTA published with
  // APP_ENV unset, where the loopback default is what the runtime guard catches.
  return process.env.LOCAL_API_URL || 'http://127.0.0.1:3000';
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

// Per-language Info.plist overrides (#671). Prebuild writes each as
// ios/<app>/Supporting/<lang>.lproj/InfoPlist.strings. Those .lproj folders
// are what the App Store reads to list the app's languages and what puts the
// permission prompts in Spanish; CFBundleLocalizations alone (expo-localization
// below) declares the languages but ships no localized resources. Keys present
// in CAMERA_PURPOSE / PHOTOS_PURPOSE stay single-sourced for English;
// __tests__/app-config.test.ts ties these keys to the languages in i18n/locales/.
const NATIVE_LOCALES = {
  en: {
    CFBundleDisplayName: 'Hooplings',
    NSCameraUsageDescription: CAMERA_PURPOSE,
    NSPhotoLibraryUsageDescription: PHOTOS_PURPOSE,
  },
  es: {
    CFBundleDisplayName: 'Hooplings',
    NSCameraUsageDescription:
      'Hooplings usa tu cámara para tomar una foto de perfil para ti o para un jugador de la plantilla de tu equipo.',
    NSPhotoLibraryUsageDescription:
      'Hooplings usa tu fototeca para que elijas una foto de perfil para ti o para un jugador de la plantilla de tu equipo.',
  },
};

export default {
  expo: {
    name: IS_PRODUCTION ? 'Hooplings' : `Hooplings (${process.env.APP_ENV || 'dev'})`,
    slug: 'bball-tracker',
    // 1.7.0 = OTA runtime boundary for the "next native binary" bundle: the
    // Sentry Expo config plugin (#644: the Xcode build phases that upload the
    // embedded bundle's source maps and the dSYMs), Spanish declared to iOS
    // through CFBundleLocalizations (#671), and the binary-coupled Expo SDK 57
    // patch, Sentry and Amplitude bumps held on #275. An OTA ships JavaScript
    // from the lockfile and runs it against the native code frozen in the
    // binary. runtimeVersion policy is appVersion: every OTA from here on
    // reaches 1.7.0 builds only, and build #34 stays on the last 1.6.0 OTA.
    //
    // Earlier boundaries: 1.6.0 was the Android App Links intent filter
    // (#716), dropping lottie-react-native and expo-status-bar (#780) and SDK
    // 57 patch bumps (build #33 stays on the last 1.5.0 OTA); 1.5.0 was the
    // Expo SDK 57 upgrade (#576: React
    // Native 0.83 -> 0.86, React 19.3.0 -> 19.2.3, every expo-* native module;
    // build #32 stays on the last 1.4.0 OTA); 1.4.0 was dependency drift (#562: Amplitude, Sentry,
    // expo-updates and react moved on main after build #31 was cut); 1.3.0 was
    // the URL scheme rename (#504: the sign-in redirect scheme is resolved
    // from the OTA MANIFEST while the schemes a binary answers are baked into
    // Info.plist, so builds #25-#30 stay on the last 1.2.0 OTA); 1.2.0 was
    // expo-secure-store (audit #52).
    version: '1.7.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    // URL scheme (#504). Sign-in asks for APP_URL_SCHEME explicitly
    // (config/env.ts) rather than reading this value, because the OTA manifest
    // carries it while the schemes a binary answers are baked into Info.plist.
    // The pre-rename scheme left the array in #513; build #31 still
    // registers it natively until its successor is cut.
    scheme: 'hooplings',
    locales: NATIVE_LOCALES,
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
      // Android App Links: the manifest half of the association whose site
      // half is https://hooplings.com/.well-known/assetlinks.json (#139).
      // Without an autoVerify https filter Android never consults
      // assetlinks.json and hooplings.com/invite/<token> opens Chrome instead
      // of the app (#716). pathPattern '/invite/.*' matches the iOS AASA
      // component '/invite/*' (web/public/.well-known/), so both platforms
      // claim the same links; a pathPrefix would also claim '/invite' and
      // '/invite-anything'. The intent filter is native: it rides the next EAS
      // build, an OTA update cannot change it. Until the web deploy (#30)
      // serves the apex and #139 supplies the fingerprint, verification fails:
      // on Android 12+ the link then opens the browser (the filter is inert),
      // but on Android 6-11 a failed autoVerify falls back to the system
      // app chooser for every hooplings.com/invite/* link.
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host: 'hooplings.com', pathPattern: '/invite/.*' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      // UIKit scene-based life cycle (#576). An app built with the iOS 27 SDK
      // (Xcode 27) on the old application life cycle does not launch correctly
      // on iOS 27. SDK 57 keeps the old life cycle unless this is set; SDK 58
      // makes it the default, where this entry becomes a no-op to remove.
      // Native: it changes AppDelegate and Info.plist at prebuild, so it ships
      // with an `eas build`, never an OTA.
      ['expo-build-properties', { ios: { enableSceneSupport: true } }],
      'expo-router',
      // Declares the app's languages to iOS (#671): CFBundleLocalizations
      // ['en', 'es'] in Info.plist, the languages i18n/locales/ ships. Without
      // it iOS treats the app as English-only: no per-app Language row in
      // Settings, and the system UI the app presents stays English on a
      // Spanish device. The iOS-only form on purpose: the array form also
      // writes Android's localeConfig and resourceConfigurations, which waits
      // for Android release work. Native (Info.plist), so it ships with an
      // `eas build`; `__tests__/app-config.test.ts` ties it to i18n/locales/.
      ['expo-localization', { supportedLocales: { ios: ['en', 'es'] } }],
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
      // Sentry symbolication (#644). Adds the Xcode build phases that upload
      // the embedded bundle's source maps and the native debug files (dSYMs)
      // to this org and project, and writes ios/sentry.properties at prebuild.
      // It pairs with getSentryExpoConfig in metro.config.js, which stamps a
      // Debug ID into every bundle (embedded or OTA), so Sentry finds the map
      // whatever release an event carries. No token here: SENTRY_AUTH_TOKEN
      // comes from the EAS production environment on the builder. Native
      // (build phases), so it ships with an `eas build`;
      // `__tests__/app-config.test.ts` pins the entry.
      [
        '@sentry/react-native/expo',
        { organization: 'satsun-ventures', project: 'bball-tracker-mobile' },
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
