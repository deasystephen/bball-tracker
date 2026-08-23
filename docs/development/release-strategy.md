# Release Strategy

`main` is the only long-lived branch and is always deployable. "Releasing" means
different things per package:

| Package | How it reaches users | Trigger |
|---|---|---|
| `backend/` | Docker image → ECR → ECS Fargate (`api.capyhoops.com`) | **Automatic** on every merge to `main` that touches `backend/` (`.github/workflows/ci.yml`; Prisma migrations run from `docker/entrypoint.sh`) |
| `mobile/` JS-only changes | EAS **OTA update** on the `production` branch | Manual: `npx eas-cli update --branch production --environment production --platform ios --non-interactive --message "…"` (run from `mobile/`) |
| `mobile/` native changes (new native module, `app.config.js` plugins/entitlements, Expo SDK bump) | EAS **build** → TestFlight / App Store | Manual: `npx eas-cli build --platform ios --profile production --auto-submit --non-interactive` |
| `web/` | Not deployed yet (`capyhoops.com` has no hosting target) | — |

## Backend

1. Merge to `main` → CI builds, pushes to ECR and rolls the ECS service (deploy
   waiter 10 min; health check `GET /health` → `{"status":"ok","db":"ok"}`).
2. Verify with `curl -s https://api.capyhoops.com/health` and the Datadog /
   Sentry dashboards. Roll back by re-deploying the previous task-definition
   revision.

## Mobile

Decide OTA vs. native build **before** merging:

- **OTA** is only for JS/asset changes. An `eas update` evaluates
  `app.config.js` on your machine — always pass `--environment production` so
  `APP_ENV`, `SENTRY_DSN` and `AMPLITUDE_API_KEY` are loaded (otherwise the
  update ships `apiUrl: http://127.0.0.1:3000`). Updates apply on the **second**
  launch after download.
- **Native build** whenever a native dependency changes (e.g.
  `@sentry/react-native`, Reanimated, Expo SDK), or `app.config.js` gains
  plugins / entitlements (`ios.associatedDomains` for Universal Links). Bump the
  marketing version in `app.config.js` when a new native build is cut; the EAS
  `appVersion` runtime policy then scopes future OTAs to that binary.
- Build numbers auto-increment on EAS (`appVersionSource: remote`) and are not
  tracked in-repo.

Never use `npm start` / Expo Go for this app — the dev client must be built with
`npx expo run:ios`.

## Tagging

Tag `main` (`git tag -a vX.Y.Z`) for notable milestones — see
[`git-workflow.md`](./git-workflow.md#tagging-releases). Tags are informational;
deploys are driven by merges, not tags.

## Pre-release verification

Run the manual E2E plan in
[`docs/testing/e2e-test-plan-v2.0.md`](../testing/e2e-test-plan-v2.0.md)
against a fresh TestFlight build + the current ECS revision before declaring a
release ready. Maestro flows in `.maestro/` cover the main mobile journeys
locally (they are not run in CI).
