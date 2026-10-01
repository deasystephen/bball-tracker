# Maestro E2E flows

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Maestro E2E Tests
- **Any major new mobile functionality must include a Maestro E2E test** in `.maestro/`
- Flows test full user journeys: login → navigate → perform action → assert result
- All flows start with `clearState: true`, skip onboarding, and dev-login as a test user
- Use `accessibilityLabel` for tab bar navigation (e.g., `"Teams tab"`, `"Profile tab"`) since inactive tabs are icon-only
- When an `accessibilityLabel` exists on a parent element, Maestro uses that instead of inner text (e.g., `"Toggle dark mode"` not `"Appearance"`)
- **`text:` is a FULL-MATCH regex against the element's accessibility text, not a substring search.**
  A composite row is ONE element whose label concatenates its fields with `", "` — a dev-user card
  reads `"Dana Whitfield, dana.whitfield@example.com, PLAYER"`, so `text: "dana.whitfield@example.com"`
  matches **nothing** while `".*dana.whitfield@example.com.*"` matches. That is why selectors here
  carry a trailing `.*` (`"Frank Vogel.*"`, `"Downtown Youth Basketball League.*"`). Do not add `.*`
  reflexively though: it widens the match, and `"Teams.*"` would also hit `"Teams tab"`. Exact strings
  are right for standalone labels (`"Roster"`, `"No teams yet"`); wildcards are for rows that
  concatenate.
- **`openLink` needs a dev client that registers the scheme.** The scheme is native (`app.config.js`
  `scheme`), so after checking out a branch that changes it, run `npx expo prebuild --platform ios --clean`
  and THEN `npx expo run:ios` before any flow that opens `hooplings://…`. `expo run:ios` alone reuses the
  existing gitignored `mobile/ios/` project and does not re-apply config changes — the Info.plist keeps the
  old `CFBundleURLTypes` and the flow fails with no handler (verified while shipping #504). Check with
  `/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" mobile/ios/*/Info.plist`.
- **`openLink` triggers an iOS system dialog.** Opening a custom scheme puts up
  *Open in "<app>"?* (Cancel / Open) — even for the app's own scheme — and that modal blocks every
  subsequent command, so the flow fails on whatever comes next with no hint of the cause. Follow every
  `openLink` with a conditional `runFlow: { when: { visible: "Open" }, commands: [ tapOn: "Open" ] }`;
  conditional because the simulator may remember the choice. `.maestro/coach-onboarding.yaml` does
  this; `.maestro/auth-callback.yaml` does **not** and is expected to fail for this reason.
- There is no tab bar on pushed routes. `app/_layout.tsx` is a `Stack` with `(tabs)` as one screen, so
  `teams/[id]`, its roster, `games/[id]` and friends render **above** the tabs — `tapOn: "Teams tab"`
  cannot work there. Reaching a tab from a pushed screen means popping back, or a deep link.
- `launchApp` mid-flow drops the session and lands on the sign-in screen. Do not use it to reset
  navigation.
- Prefer `testID` over text whenever a label is ambiguous. The create-team submit button is
  `common.create` ("Create") while the screen header is `teams.create` ("Create Team"), so a text tap
  on `"Create"` is ambiguous — it taps `id: create-team-submit` instead.
- `visibilityPercentage` defaults to 100 on `scrollUntilVisible`, which fails on a row resting at the
  screen edge even though it is plainly readable. Relax it (60 is fine) for list hunting.
- **The developer login list has a fixed order (#584):** the accounts the seed creates for
  signing in come first, then everything else; inside each group by role (COACH, PARENT, PLAYER,
  ADMIN), then name, then id (`backend/src/api/auth/dev-users.ts#orderDevUsers`). Coaches and
  parents fit on the first screen; players need `scrollUntilVisible`. It used to be ordered by
  role alone, so the order inside a role changed as rows were updated.
- **The seed removes what it knows about, and nothing else.** Two lists have to stay current:
  the games flows create (`backend/tests/support/flow-fixtures.ts#FLOW_CREATED_OPPONENTS`; a test
  reads `.maestro/` and fails when a flow creates a game whose opponent is not listed) and the
  rows real-database tests leave behind (next section, "Real-database suites").
  `live-spectator.yaml`'s "Spectator Rival" was missing from the first list until #584; its
  games stay in progress, and the Games tab had filled with them.
- **Flows mutate the database, and `clearState: true` does not undo that.** Any flow that changes a
  role or creates rows needs a matching reset in `backend/prisma/seed.ts`, and `npx prisma db seed`
  must be run before each run. `.maestro/coach-onboarding.yaml` is the worked example: the seed puts
  Dana back to `PLAYER` and deletes her teams, personal league and managed players. Miss one and the
  fixture drifts — the leaked managed player pushed her down the dev-login list until an unrelated
  step timed out.
- For scrolling, use explicit coordinates to avoid hitting the raised Track button in the center tab bar (e.g., `start: 50%, 60%` / `end: 50%, 20%`)
- **Never use `hideKeyboard`.** On iOS it often cannot hide the keyboard (number pads AND text
  keyboards). Up to Maestro 2.1 it then did nothing, and a tap on a button behind the keyboard
  landed on a keyboard key instead (the profile.yaml rename kept typing a stray "v" from tapping
  Save). **Since Maestro 2.11 it fails the flow** ("Hide Keyboard... FAILED"): the upgrade broke
  the two flows that still used it (#584). No flow uses it any more. Deterministic dismissals:
  `pressKey: Enter` for a single-line input (blurs on submit), or — inside a ScrollView with
  `keyboardShouldPersistTaps="handled"` — tap any non-interactive text such as the field's own
  label, which is the only way out of a number pad (it has no return key).
- **A row under the on-screen keyboard counts as visible, and a tap on it lands on the keyboard.**
  `scrollUntilVisible` does not scroll for it, with or without `centerElement`, and the tap types
  into whatever field has focus (the flow then fails on its next assert, with a stray word in the
  input as the only clue). It depends on keyboard geometry: `.maestro/game-create-date.yaml` passed
  on iOS 27 and failed on iOS 26.5 for this reason. On a screen that opens with a focused field,
  dismiss the keyboard first (`pressKey: Enter`), then scroll and tap.
- **`assertVisible` passes on rows behind the translucent tab-bar overlay; taps there silently no-op**
  (content deliberately scrolls behind the bar). Before tapping anything near the bottom of a tab
  screen, `scrollUntilVisible` with `centerElement: true` so the tap point clears the bar.
- **Don't use `centerElement: true` for elements near the END of a list** — centering can never be
  satisfied there and the scroll spins until timeout with the element plainly visible. Plain
  `visibilityPercentage: 60` is the stop condition that works.
- **Icon glyphs are part of a composite label.** A row that starts with an `Ionicons` glyph reads
  `"\uf601, Leagues & Seasons, Create and manage leagues, \uf23b"`, so a trailing `.*` is not enough:
  `".*Leagues & Seasons.*"`. Better, give the pressable its own `accessibilityLabel` (VoiceOver then
  stops reading the glyph too), as the league screen's "Add Season" button now has.
- **Two elements with the same text: tap by id.** `tapOn: "Create Season"` on the Create Season screen
  "COMPLETED" by tapping the header title, not the button, and the flow then asserted the name it had
  typed into the still-open form (found while writing `admin-season-manage.yaml`). Every submit button
  on the admin forms now carries a `testID` (`season-create-submit`, `league-create-submit`,
  `season-save-button`); a flow that taps text shared with a title is wrong even when it passes.
- **Never start Metro with `CI=1` for a Maestro session.** CI mode disables file watching
  ("reloads are disabled"), so every edit after launch is invisible to the app while a `curl` of the
  bundle looks fresh. From a non-interactive shell use `npx expo start --port 8081 --clear < /dev/null`.
  `launchApp` with `clearState: true` reinstalls the app on iOS (the container path changes); it is not
  another session installing over you.
- A tap/assert that navigates away and back can land at the previous scroll offset — an element at the
  top of the screen may then be off-screen ABOVE; scroll `direction: UP` before asserting it.
- Run with: `maestro test .maestro/` or `maestro test .maestro/<flow>.yaml`. **Run the suite
  sequentially, with a fresh `npx prisma db seed` before every flow** — the seed is the reset
  between flows (it restores mutated fixture names and roles, deletes flow-created teams, games
  and players, and removes what interrupted test runs left behind), so never run two flows
  back-to-back without it. **Last full run: 22 of 22, every flow on its first attempt, on
  2026-09-29, on Maestro 2.11.0** (iPhone 17 simulator on iOS 26.5, Expo SDK 57 build; a 23rd
  flow, `error-way-back.yaml`, was added later that day and passed on its own; a 24th,
  `admin-season-manage.yaml` (#614, dev-login as the seeded ADMIN, create → edit → delete a season,
  then the league delete refused for teams), was added 2026-09-30). The same
  day it was also 22 of 22 on Maestro 2.1.0, which had hung mid-flow under Xcode 27 on
  2026-09-27 and 28; no hang has been seen on 2.11.0, in three full runs. Still run each flow
  under a time limit with one retry: a hung driver otherwise stalls the whole suite. **After a
  Maestro upgrade, run the full suite before trusting it**: 2.1 → 2.11 changed what
  `hideKeyboard` does and broke two flows. Nightly CI for the suite was
  attempted and closed as not planned (#441 records the CI learnings and a WIP branch, should it ever
  be revived); flows are deliberately manual-only.
