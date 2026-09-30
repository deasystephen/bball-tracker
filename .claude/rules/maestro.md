---
paths:
  - ".maestro/**"
---

# Maestro rules

Loaded when a task touches `.maestro/`. Full gotcha list and history: `docs/testing/maestro.md`.

- Flows are manual only (no CI). Run sequentially, `cd backend && npx prisma db seed` before
  **every** flow; a flow that mutates data needs a matching reset in `backend/prisma/seed.ts` and
  its created opponents listed in `backend/tests/support/flow-fixtures.ts`.
- Every flow starts with `clearState: true`, skips onboarding and dev-logs-in as a seeded user.
  `launchApp` mid-flow drops the session; never use it to reset navigation.
- `text:` is a **full-match regex** on the accessibility label; composite rows concatenate fields
  with `", "`, so use `"Frank Vogel.*"` for rows and exact strings for standalone labels. Prefer
  `testID` when text is ambiguous (`id: create-team-submit`).
- Tab bar taps use `"<Name> tab"` labels; there is no tab bar on pushed routes (pop back or deep-link).
- **Never use `hideKeyboard`** (fails flows since Maestro 2.11). Dismiss with `pressKey: Enter` or
  by tapping non-interactive text. A row under the keyboard counts as visible and a tap on it types.
- `assertVisible` passes behind the translucent tab bar; `scrollUntilVisible` with
  `centerElement: true` before tapping near the bottom, but not for elements at the end of a list
  (use `visibilityPercentage: 60`). Scroll with explicit coordinates to miss the centre Track button.
- `openLink` needs a dev client that registers `hooplings://` (prebuild `--clean` after a scheme
  change) and triggers an *Open in "app"?* dialog: follow it with a conditional
  `runFlow: { when: { visible: "Open" }, commands: [ tapOn: "Open" ] }`.
- Chip and status assertions use the row-anchored label (`"<player> status: <label>"`), never a
  bare `assertVisible: "Active"`.
- The dev-login list is ordered seeded sign-in accounts first, then by role, name, id; players need
  `scrollUntilVisible`. The first flow after an install can fail on its first tap while Metro
  builds the bundle; launch the app once before a suite.
