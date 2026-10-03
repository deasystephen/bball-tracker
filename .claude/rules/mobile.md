---
paths:
  - "mobile/**/*"
---

# Mobile rules

Loads when a file under `mobile/` is read. Detail: `docs/architecture/mobile-app.md`,
`docs/architecture/roster-and-invitations.md`, `docs/deployment/mobile-builds-and-ota.md`.

- Build with `npx expo run:ios`, never `expo start` / Expo Go, never `CODE_SIGNING_ALLOWED=NO`.
  After a native config change (`scheme`, plugins, permissions): `npx expo prebuild --platform ios --clean` first.
- API host only from `config/env.ts#getApiUrl()`; sign-in scheme only from `APP_URL_SCHEME`.
- Derive, never inline: `getRosterStatus`, `getEmailDeliveryIssue`, `getGameResult`,
  `formatShotDescription`, `sortRosterMembers`, `formatTeamBracket`, `displayName`,
  `hasTeamPermission` / `team-permissions` / `game-permissions`. Jersey `0` is valid (`!= null`).
- Shared components are mandatory: `DateTimePickerSheet` for dates and times, `ActionMenu` for
  per-row menus (never an `Alert` menu), `SortPills` for pill rows, `useTabBarPadding()` for tab
  scroll padding, `ErrorState` with `onBack={useGoBack(parent)}` on pushed screens.
- Never nest a pressable inside a pressable (source-scanning test). Toasts get no touch handlers.
- Auth store: `updateUser` for edits, `setUser` only at login; prefer selectors over a bare
  `useAuthStore()`. New unauthenticated endpoints go into `PUBLIC_PATHS` in `services/api-client.ts`.
- Native modules behind `requireOptionalNativeModule`; upload parts are `expo-file-system` `File`s.
- No bare `console.*` in app code (ESLint `no-console`; allowed in `services/log.ts`, `__tests__/`,
  `scripts/`): use `services/log.ts` (`log.debug/info` dev-only, `log.warn/error` also breadcrumb).
  Sentry tags and breadcrumbs take URLs only as `endpointPattern(url)`; errors a user cannot act on
  (network, 5xx) are captured by the api-client, 4xx are not. Detail: `docs/architecture/mobile-app.md`.
- Screen tests render the real i18n instance; the brand guard fails on retired names anywhere in
  mobile source, locales or `.maestro/`, comments included.
- Analytics: every user-facing mutation hook fires a catalogued event from `onSuccess`
  (`trackEvent(AnalyticsEvents.X, props)`); names are `snake_case` `<object>_<past-tense verb>`
  and live only in `services/analytics.ts#AnalyticsEvents` with typed props. **No property may
  carry PII**: ids, enums, counts and flags only, never a name, email, jersey number or message
  (`fields` names keys, not values). A new event gets a row in `docs/architecture/analytics.md`
  in the same PR; `__tests__/analytics/catalogue-guard.test.ts` fails otherwise.
- Packages with native code (`expo-*`, Sentry, Amplitude, `react-native-*`, `react`) move only
  with a native build and a runtime bump; `npm test` fails otherwise. Never edit
  `binary-manifest.json` by hand. Production OTA: `npm ci && npm run ota:production` (the script
  runs the drift guard, then `eas update --environment production`, which supplies `APP_ENV`);
  verify the served manifest; publish it in the
  same session as the merge.
- Entitlements, permission strings, icons and splash ship only with an `eas build`.
- Major new functionality gets a Maestro flow and, if it mutates data, a reset in the seed.
