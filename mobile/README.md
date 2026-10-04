# Hooplings Mobile App

React Native mobile application built with Expo for iOS and Android.

## Tech Stack

- **Framework**: React Native with Expo
- **Navigation**: Expo Router (file-based routing)
- **State Management**: 
  - Zustand (client state)
  - TanStack Query (server state)
- **HTTP Client**: Axios
- **Storage**: session tokens in the iOS Keychain / Android Keystore via `expo-secure-store`; `user` and flags in AsyncStorage (Zustand persist through `services/secure-storage.ts`)

## Setup

### Prerequisites

- Node.js 22+
- Xcode 26.4 or newer (for iOS Simulator) on macOS, or Android Studio for the Android Emulator. Xcode 27 works: the project is on Expo SDK 57, whose CLI knows that Xcode 27 replaced `Simulator.app` with `DeviceHub.app`. Minimum iOS is 16.4.
- EAS CLI (`npx eas-cli` works via the local dev dep — no global install needed)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Run on iOS (builds the dev client — needed for native modules like Sentry):
```bash
npx expo run:ios
```

3. Run on Android:
```bash
npx expo run:android
```

If `npx expo run:ios` stops with **"No code signing certificates are available to use"**: the app has the Associated Domains entitlement, and the Expo CLI wants a development certificate for it even on the simulator.

1. Check what macOS considers valid: `security find-identity -v -p codesigning`.
2. No certificate listed: Xcode → Settings → Accounts → Manage Certificates → "+" → Apple Development.
3. A certificate exists but the command still reports 0 valid identities: install the certificate of Apple's issuing authority.
   ```bash
   curl -o ~/Downloads/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
   security add-certificates -k ~/Library/Keychains/login.keychain-db ~/Downloads/AppleWWDRCAG3.cer
   ```

After switching branches across an Expo SDK change, run `npm ci` and `npx expo prebuild --platform ios --clean` first; `run:ios` alone reuses the existing `ios/` folder. `docs/deployment/mobile-builds-and-ota.md` ("Toolchain") describes a build that needs no certificate.

**Do not use** `npm start` / `npx expo start` with this project. Several native modules (Sentry, Reanimated, etc.) require a custom dev client; the legacy Expo Go flow does not work here. See `npx expo run:ios --help` for device-selection flags.

## Project Structure

```
mobile/
├── app/              # Expo Router screens (file-based routing)
│   ├── _layout.tsx   # Root layout
│   ├── index.tsx     # Initial screen (auth check)
│   ├── login.tsx     # Login screen
│   └── (tabs)/       # Tab navigation group
│       ├── _layout.tsx
│       ├── home.tsx
│       ├── teams.tsx
│       ├── games.tsx
│       ├── stats.tsx
│       ├── invitations.tsx
│       └── profile.tsx
├── components/       # Reusable UI components
├── hooks/            # Custom React hooks
├── services/         # API clients, external services
│   └── api-client.ts
├── store/            # Zustand stores
│   └── auth-store.ts
├── types/            # TypeScript types
└── utils/            # Utility functions
```

## Environment Variables

The API host is decided in one place, `config/env.ts#getApiUrl()`, from `extra.apiUrl` in `app.config.js`. That value is fixed at build or OTA-publish time from `APP_ENV`:

- `APP_ENV=production` or `APP_ENV=preview`: `https://api.hooplings.com`. `API_URL` overrides the host in those two environments only.
- Anything else, including unset: `http://127.0.0.1:3000` (the local dev server). `API_URL` is ignored here.

Local `npx expo run:ios` / `run:android` needs no variables. `eas build` and `eas update` read them from the EAS environment: always pass `--environment production` to `eas update`, or the update ships the dev host to every device (the "OTA env gotcha" in `docs/deployment/mobile-builds-and-ota.md`). The other `extra` keys are resolved the same way: `appEnv` (`APP_ENV`, or `development` when unset), `amplitudeApiKey` (`AMPLITUDE_API_KEY`, production and preview only; analytics are off in local development), `sentryDsn` (`SENTRY_DSN`; unset locally, so no events ship), `sentryEnvironment` (`SENTRY_ENVIRONMENT`, falling back to `APP_ENV`, then `development`) and `sentryRelease` (`SENTRY_RELEASE`, set by CI). `__tests__/app-config.test.ts` pins the mapping.

## Development

- The app uses Expo Router for navigation
- Authentication state is managed with Zustand; the tokens are persisted to the Keychain/Keystore (`expo-secure-store`) and the rest (`user`, flags) to AsyncStorage via `services/secure-storage.ts`. Detail: `docs/architecture/auth-sessions.md`
- API calls use TanStack Query for caching and state management
- All API requests automatically include the auth token from the store
- Architecture, routing and the mobile rules: the repo's `docs/architecture/mobile-app.md`; theme tokens and the mandatory shared components: `mobile/docs/design-system.md`

## License

Apache 2.0
