# App Store submission: drafts for App Store Connect

Draft content for the first public App Store submission of Hooplings (#451). Everything here is
derived from the code at the time of writing, with the file that supports each claim. It is input
for the person filling in App Store Connect, **not a record of what was submitted** and not a task
list: outstanding work lives on the GitHub issues referenced below.

Re-verify the tables against the code before submitting. A new SDK, a new analytics property or a
new permission changes the answers.

## 1. Permission purpose strings (in the binary)

Set in `mobile/app.config.js` through config-plugin options and pinned by
`mobile/__tests__/app-config.test.ts`. They are baked into `Info.plist` when the native build is
cut; an OTA update cannot change them.

| Info.plist key | Value | Why the app asks |
| --- | --- | --- |
| `NSCameraUsageDescription` | "Hooplings uses your camera to take a profile photo for you or for a player on your team roster." | `components/AvatarPicker.tsx` "Take Photo" |
| `NSPhotoLibraryUsageDescription` | "Hooplings uses your photo library so you can choose a profile photo for yourself or for a player on your team roster." | `components/AvatarPicker.tsx` "Choose from Library" |

The picker is used in exactly two places: the signed-in user's own photo
(`app/(tabs)/profile.tsx`) and the photo a coach attaches when adding a player
(`app/teams/[id]/players.tsx`). It is images-only (`mediaTypes: ['images']`), square-cropped, and
the result is uploaded by `services/upload-service.ts`.

Removed because the app never uses the capability:

| Key / permission | Source of the default | Evidence it is unused |
| --- | --- | --- |
| `NSMicrophoneUsageDescription` (iOS), `android.permission.RECORD_AUDIO` (Android) | `expo-image-picker` config plugin | No video or audio capture anywhere; the picker requests images only |
| `NSFaceIDUsageDescription` (iOS) | `expo-secure-store` config plugin | `services/secure-storage.ts` never passes `requireAuthentication`; tokens use `AFTER_FIRST_UNLOCK` keychain items with no biometric gate |

No location, contacts, calendar, Bluetooth, motion or tracking (`NSUserTrackingUsageDescription`)
key is present in the evaluated config, and none of those capabilities has a native module in
`mobile/package.json`. Push notifications need no purpose string; iOS shows its own prompt.

## 2. App Privacy label answers (draft)

Apple's definitions used below: data is **collected** when it leaves the device and is kept
longer than needed to service the request; it is **linked** when it is stored against an
identity; **tracking** means combining it with third-party data for advertising or sharing it
with a data broker.

**Tracking: No, for every row.** The app has no advertising SDK and shares data with no data
broker. It reads no advertising identifier: on iOS the Amplitude module reads
`identifierForVendor` only (`node_modules/@amplitude/analytics-react-native/ios/AppleContextProvider.swift`),
and on Android the advertising id is switched off (`adid: false` in `AMPLITUDE_TRACKING_OPTIONS`,
`mobile/services/analytics.ts`). No App Tracking Transparency prompt is needed.

| Apple data type | What is collected | Feature / SDK | Linked to identity | Purpose | Evidence |
| --- | --- | --- | --- | --- | --- |
| Contact Info: Name | The user's display name; names of players a coach adds | Sign-in (WorkOS), Profile name editor, Add Player | Yes | App Functionality | `backend/src/services/workos-service.ts` (`syncUser`), `mobile/app/onboarding/name.tsx`, `mobile/app/teams/[id]/players.tsx` |
| Contact Info: Email Address | The user's sign-in email; player and parent emails a coach enters to send invitations | Sign-in (WorkOS), invitations (sent through Amazon SES) | Yes | App Functionality | `mobile/app/login.tsx`, `mobile/app/teams/[id]/players.tsx`, `backend/src/services/mailer/` |
| User Content: Photos or Videos | One profile photo per person (photos only, no video) | Avatar upload to Amazon S3 | Yes | App Functionality | `mobile/services/upload-service.ts`, `backend/src/services/upload-service.ts` |
| User Content: Other User Content | Teams, rosters, jersey numbers and positions, games, scores, game events and statistics, RSVPs, announcements | Core product | Yes | App Functionality | `backend/prisma/schema.prisma` |
| Identifiers: User ID | The internal account id (a UUID), with user properties that describe the account, not the person: global role, whether they hold a head-coach or assistant-coach staff role, whether they are a parent or a player, how many teams they can see, subscription tier, app version | Backend account; Amplitude `setUserId` + `identify` | Yes | App Functionality, Analytics | `mobile/store/auth-store.ts` (`identifyUser(user.id, userPropertiesFrom(user))`), `mobile/hooks/useTeams.ts`, `mobile/hooks/useUsage.ts`, table in `docs/architecture/analytics.md` |
| Identifiers: Device ID | Expo push token; Amplitude device id and `identifierForVendor` | Push notifications; Amplitude (`idfv: true`) | Yes | App Functionality (push), Analytics (Amplitude) | `mobile/hooks/useNotifications.ts` (`POST /auth/push-token`), `mobile/services/analytics.ts` (`AMPLITUDE_TRACKING_OPTIONS`) |
| Location: Coarse Location | City, region and country, derived by Amplitude on its servers from the IP address of the request. The device's location services are never used | Amplitude (`ipAddress: true`) | Yes (events carry the user id) | Analytics | `mobile/services/analytics.ts` (`AMPLITUDE_TRACKING_OPTIONS`), note 3 |
| Usage Data: Product Interaction | The catalogued events in `docs/architecture/analytics.md` (#616): app opens, screen views as route patterns (`/teams/[id]`, never the id), sign-in and sign-out, onboarding steps, and every create / update / delete the user performs on teams, rosters, staff, invitations, guardians, announcements, leagues, seasons, games, game events and RSVPs, plus push-permission answers, notification taps, entitlement denials and errors shown. **Properties are internal ids, enums, counts and booleans only**: which fields changed (not their values), an error's code and status (not its message), a route pattern with ids collapsed. No name, email, jersey number, message text or photo | Amplitude | Yes (events carry the user id) | Analytics | `mobile/services/analytics.ts` (`AnalyticsEvents`, `AnalyticsEventProps`), the emitters listed per event in `docs/architecture/analytics.md`, guard `mobile/__tests__/analytics/catalogue-guard.test.ts` |
| Diagnostics: Crash Data | Unhandled errors and caught exceptions with stack traces | Sentry | No (see note 1) | App Functionality | `mobile/services/sentry.ts` |
| Diagnostics: Performance Data | Sampled performance transactions (`tracesSampleRate: 0.1`) | Sentry | No (see note 1) | App Functionality | `mobile/services/sentry.ts` |
| Diagnostics: Other Diagnostic Data | Breadcrumbs (navigation and request URLs, redacted), device model, OS version, app release | Sentry; Amplitude device context | Sentry: No. Amplitude: Yes | App Functionality, Analytics | `mobile/services/sentry.ts`, `AMPLITUDE_TRACKING_OPTIONS` |

Not collected: precise location (the app requests no location permission), contacts, health, financial or payment data, browsing or search
history, sensitive information, audio, messages, advertising data. There is no in-app purchase
flow.

### Notes that change an answer

1. **Sentry is not linked to the user in the mobile app.** `services/sentry.ts` exports
   `setSentryUser`, but nothing calls it, and `Sentry.init` sets `sendDefaultPii: false`. Mobile
   events therefore carry no account id. If a later change starts calling `setSentryUser`, the
   three Diagnostics rows become **linked**. Note that `docs/runbooks/data-subject-requests.md`
   ("Retention") describes error reports as keyed on the internal user id; that holds for the
   backend, and the privacy policy (#25) should not claim more than the code does.
2. **What Sentry redacts before sending** (`beforeSend` and `beforeSendTransaction` in
   `mobile/services/sentry.ts`): request bodies are replaced wholesale; header, cookie, extra and
   context keys matching `authorization`, `cookie`, `password`, `token`, `secret`, `jwt`,
   `session`, `email`, `otp` and similar are scrubbed; URLs are redacted by value, masking
   `code`, `state` and `token` query values and the secret path segment after `by-token/`,
   `calendar/` and `invite/`. Resource ids in URLs (team and game UUIDs) are not masked.
3. **Amplitude's tracking options are set explicitly (#559).** `amplitude.init` is passed
   `AMPLITUDE_TRACKING_OPTIONS` (`mobile/services/analytics.ts`), so nothing depends on the SDK's
   defaults, and `mobile/__tests__/services/analytics.test.ts` fails if an SDK upgrade adds an
   option the app has not decided. Sent with every event: the IP address of the request,
   `identifierForVendor`, the Android app set id, device manufacturer and model, OS name and
   version, platform, language and carrier. Not sent: the Android advertising id.
   **Keeping the IP address is a product decision (2026-09-27):** Amplitude resolves it into
   city, region and country, which is wanted for analytics, so **Location: Coarse Location** is
   declared above. Whether Amplitude also retains the raw IP address after the lookup is an
   Amplitude project setting, not visible in code; see section 4.
4. **Children's data is entered by adults.** A coach can add a minor's name, photo and email to a
   roster, and a guardian can be linked to a child's record. Whether this makes the answers
   "data collected from children" depends on the age-rating and child-directed decisions in
   section 4.
5. **On-device only, not collected:** session tokens in the Keychain
   (`mobile/services/secure-storage.ts`), the sort preference, onboarding flags and the PKCE
   verifier in AsyncStorage.

## 3. Review notes (draft)

Paste into "App Review Information → Notes", after filling in the placeholders.

> Hooplings is a team management and live stat tracking app for youth and amateur basketball.
> Coaches create teams, manage rosters and record game events; players and parents follow
> schedules, RSVP and view box scores.
>
> **Signing in.** Tap "Skip" on the intro, then sign in. Sign-in opens our identity provider's
> hosted page in the system browser and returns to the app.
>
> Demo account (coach, with a populated team, roster and finished games):
> - Email: `<DEMO_ACCOUNT_EMAIL — maintainer fills in>`
> - Password: `<DEMO_ACCOUNT_PASSWORD — maintainer fills in>`
>
> **Coach flow from a brand-new account.**
> 1. After the first sign-in the app asks "How will you use Hooplings?". Choose "I coach a team",
>    then Continue.
> 2. Open the Teams tab and tap "Create new team". Enter a team name and tap Create. No league or
>    season has to be chosen; the app files the team under the coach's own teams.
> 3. On the team screen tap "Add Player", then the add button, enter a name and save. The player
>    appears on the roster immediately. Email is optional and only used to send an invitation.
> 4. Open the Games tab, tap "Create new game", enter an opponent, pick the team, tap
>    "Create Game".
> 5. Open the game and tap "Start Game". Tap a player, then a shot or stat button to record it.
>    Each entry can be undone for five seconds. "End Game" finalizes the box score, which is
>    then shown on the game screen.
>
> **Permissions.** The camera and photo library are requested only when the user taps a profile
> photo and chooses "Take Photo" or "Choose from Library". Notifications are requested after
> sign-in and are optional. The app does not request the microphone, location or contacts
> permissions. Analytics derives an approximate city and country from the network address; the
> device's location is never read.
>
> **Account deletion (Guideline 5.1.1(v)).** Profile tab → Account → "Delete account". The screen
> lists what is removed and what is kept, and requires typing DELETE to confirm. Deletion is
> immediate and signs the user out. A user who is the only Head Coach of an active team is asked
> to hand the team over or delete it first; the screen links to the teams concerned.
>
> **Deleting a child's record (parents and guardians).** Profile tab → "My kids" → the "⋯" menu
> on the child's row → "Delete <child>'s record". This is offered for child records that have no
> sign-in of their own. A child who has their own sign-in deletes their account from their own
> Profile.
>
> **Purchases.** The app has no in-app purchases and no paid features.

Facts behind the notes, for whoever maintains them:

| Claim | Evidence |
| --- | --- |
| Reviewers cannot use the developer login | It renders only under `__DEV__` (`mobile/app/login.tsx`), and the backend accepts dev tokens only with `NODE_ENV=development` |
| Team creation needs no league or season | #442; `.maestro/coach-onboarding.yaml` exercises the path end to end |
| Player is rostered at once, email optional | `POST /teams/:teamId/players`, case 1 (CLAUDE.md "Team Invitations & Unified Add Player") |
| Tracking steps and labels | `.maestro/game-tracking.yaml` |
| Account deletion path and copy | #444; `mobile/app/account/delete.tsx`, `mobile/i18n/locales/en.json` (`account.delete.*`) |
| Guardian deletion is limited to managed child records | `guardianOf[].isManaged`; `DELETE /players/:id/account` |
| No purchases, no paid features | The mobile app has no entitlement UI or purchase flow (CLAUDE.md "Entitlements / Feature Gating"); the free-tier team cap was lifted in #445, so no limit is enforced on any tier |

The demo account must exist in the identity-provider environment the submission build talks to
(#24 covers the production-key cutover) and needs seeded data in the production database; both
are tracked on #451.

## 4. Open decisions for the maintainer

**None of these is decided by this document.** Each needs a human decision, recorded on the
issue named.

| Decision | Why it is open | Tracked in |
| --- | --- | --- |
| Age rating | Depends on the intended audience; drives the "data collected from children" answers | #451 |
| Whether the app is declared child-directed (Kids category, "Made for Kids") | Interacts with the COPPA read in the privacy policy work and must not be answered independently of it | #25, #451 |
| Privacy Policy URL | Required field; the document is not published. The labels in section 2 must match it, including the retention statement in `docs/runbooks/data-subject-requests.md` | #25 |
| Support URL | Required field. The inbox exists (`support@hooplings.com`, #555) and the app and every email name it (#450); the **page** does not, and it needs the web deploy | #450, #30 |
| Screenshots for the required device sizes | Not producible from code | #451 |
| Demo account credentials and seeded data | Placeholders in section 3 | #451 |
| Whether Amplitude retains the raw IP address | The app sends the IP address so that Amplitude can derive city and country (decided, see note 3). Whether the address itself is kept afterwards is a setting in the Amplitude project. It does not change the label, which already declares Coarse Location, but the privacy policy should say which it is | #25 |
| Sign-in methods offered on the hosted sign-in page | Configured in the identity provider's dashboard, not in this repository. If any third-party social login is enabled, Guideline 4.8 requires an equivalent privacy-preserving option such as Sign in with Apple | #451 |
| Sentry IP address storage | Whether Sentry stores the client IP is a Sentry project setting, not visible in code | #451 |

## 5. Minimum iOS version

**iOS 16.4** (decided 2026-09-27, #576). It is set by Expo SDK 57, up from 15.1 on SDK 55, and
drops iPhone 7 / 7 Plus, iPhone 6s / 6s Plus, iPhone SE (1st generation), iPad mini 4 and
iPad Air 2. App Store Connect reads the minimum from the binary; nothing is entered by hand.
Screenshots and the review device need iOS 16.4 or newer.

## 6. Ordering constraint

The purpose strings in section 1 reach users only in a native build cut after they merged. Cut
the submission build from a commit that contains them, and confirm in the built app that the
camera and photo prompts show the Hooplings text. See CLAUDE.md "Mobile Builds (EAS)" for the
build, runtime-version and OTA rules.
