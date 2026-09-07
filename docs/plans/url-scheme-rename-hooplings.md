# Plan: rename the URL scheme `bball-tracker://` → `hooplings://` (#504)

Split out of the domain migration (#499, decision D8 in `docs/plans/domain-migration-hooplings.md`).
Branch `feature/504-hooplings-url-scheme`. Written 2026-09-06, before any code; reviewed with
`/plan-eng-review` the same day (report at the end).

## Problem

Every human-facing identifier moved to Hooplings (#431 in-app copy, #499 domains). The custom URL
scheme is still `bball-tracker://`. **This is identifier hygiene, not a user-visible fix:** the iOS
"Open in Hooplings?" sheet shows the app's display name, never the scheme, so the only person who
ever reads `bball-tracker://` is a developer in the WorkOS dashboard or a Maestro flow. The rename is
still worth doing before there are real users, because afterwards it costs a native build plus an
overlap window for every installed device, and that price only grows. The bundle id
`com.bballtracker.mobile` and the EAS slug are **out of scope** (#505; the bundle id never changes
because it would create a new App Store app).

## Where the scheme lives today (verified against `main` at ff4186b)

| Surface | File:line | Today |
| --- | --- | --- |
| Native registration (Info.plist / AndroidManifest at prebuild) | `mobile/app.config.js:30` | `scheme: 'bball-tracker'` |
| Sign-in redirect URI | `mobile/app/login.tsx:58` | `Linking.createURL('auth/callback', {})` → scheme from the **manifest** |
| Backend allowlist for `redirect_uri` on `GET /auth/login` | `backend/src/api/auth/routes.ts:175` | `ALLOWED_REDIRECT_SCHEMES \|\| 'bball-tracker'` |
| Production env | `infra/task-definition.json` | `ALLOWED_REDIRECT_SCHEMES` **not set** — production runs on the code default |
| WorkOS dashboard redirect URIs (Staging environment; #24 will create Production) | external | `bball-tracker://auth/callback` |
| Web invite page "Open in app" | `web/app/invite/[token]/invite-client.tsx:80` | `bball-tracker://invite/${token}` (web is not deployed, #30) |
| Web App Store links | `web/app/page.tsx:10`, `invite-client.tsx:40` | placeholder `apps.apple.com/app/basketball-tracker/id000000000` |
| Maestro deep links | `.maestro/auth-callback.yaml:19`, `.maestro/coach-onboarding.yaml:171,226` | `openLink: "bball-tracker://…"` |
| Brand guard | `mobile/__tests__/i18n/brand-guard.test.ts:26,199` | comment + self-test say the scheme is a kept identifier |
| Docs (scheme literals only) | `CLAUDE.md:7`, `backend/env.example:21`, `docs/deployment/aws-setup.md:130`, `backend/docs/workos-setup-steps.md:176`, `docs/testing/e2e-test-plan-v2.0.md` (×9), `docs/testing/workos-test-accounts.md:120,123` | literal `bball-tracker://` |
| Comments only | `mobile/app/auth/callback.tsx:2,36`, `mobile/app/invite/[token].tsx:2`, `mobile/utils/pkce.ts:4`, `mobile/app/login.tsx:49` | literal |
| Test fixtures | `mobile/__tests__/app/login.test.tsx:18,62`, `mobile/__tests__/utils/return-path.test.ts:44`, `backend/tests/api/auth.test.ts:157,162` | literal |

`mobile/utils/return-path.ts` (named in the issue) carries **no** scheme literal; it rejects any
scheme. Nothing to change there beyond a test fixture. **The sweep is `bball-tracker://` only:**
bare `bball-tracker` is the EAS slug, the AWS resource prefix (`bball-tracker-production/…` in
`docs/testing/workos-test-accounts.md:184`) and part of fixture emails such as
`admin@bball-tracker.com` (`:149`); a find-and-replace on the bare word corrupts them.

## The hazard that shapes the design: the scheme rides the OTA manifest

`expo-linking`'s `createURL` with no explicit `scheme` resolves the scheme from
`Constants.expoConfig.scheme` (`node_modules/expo-linking/build/Schemes.js`, `collectManifestSchemes`
→ `resolveScheme` picks `manifestSchemes[0]`). `Constants.expoConfig` comes from the **update
manifest**, which an `eas update` replaces. The schemes the binary actually answers come from
Info.plist / AndroidManifest, baked at build time.

So if `scheme` changes in `app.config.js` and a production OTA on runtime 1.2.0 reaches builds
#25–#30, every one of those installs starts asking WorkOS to redirect to `hooplings://auth/callback`,
which the binary does not register. Sign-in breaks on every installed device and no rollback short
of republishing an older OTA fixes it. The issue's "an old TestFlight build still signs in" done
criterion is exactly this hazard.

```
                 app.config.js scheme
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   eas build (native)          eas update (OTA manifest)
   Info.plist CFBundleURLSchemes   Constants.expoConfig.scheme
   = what the OS will deliver      = what createURL() will ASK for
          │                           │
          └────── must agree ─────────┘
        A 1.2.0 binary + a manifest that says `hooplings`
        = redirect nobody answers = sign-in dead
```

## Design

### D-A  Move the OTA runtime boundary: `version: '1.2.0'` → `'1.3.0'` (eng review 1A)

`runtimeVersion: { policy: 'appVersion' }` means bumping `version` moves the OTA target. Every
`eas update` published from this commit on reaches **1.3.0 binaries only**; builds #25–#30 keep the
last 1.2.0 OTA (`9fc0a45d…`, which already points at `api.hooplings.com`, so they stay healthy) and
never receive a manifest that names `hooplings`. This is the exact mechanism used for
`expo-secure-store` (1.1.0 → 1.2.0, audit #52) and is already documented in CLAUDE.md.

With the two-PR rollout below there is **no OTA freeze**: build #31 exists and is verified before
the mobile PR merges, so `main` never targets a runtime with no binary.

Collateral of the bump (all in PR B):
- `mobile/__tests__/app/about.test.tsx` pins `'1.2.0'` in its mocks (eight places). They keep
  passing, but they describe a build no OTA reaches any more; update the fixture to `1.3.0` and
  the build number to 31 so the test reads true.
- `app/about.tsx:43` and `services/secure-storage.ts` comments describe the 1.2.0 boundary
  ("OTAs on runtime 1.2.0 still reach builds #25–#27"). Keep the `requireOptionalNativeModule`
  guards — they are still correct defensive code — but reword the comments to say the 1.3.0
  boundary now makes the module guaranteed, and the guard stays for symmetry with secure-storage.
- Sentry release becomes `1.3.0+<easBuildId>` (`services/sentry.ts:213-218`); any alert filtered
  on release `1.2.0` stops matching (none are known to exist; check the Sentry MCP before merge).
- CLAUDE.md has four 1.2.0-specific paragraphs, not one: "Runtime version 1.2.0 (audit #52)",
  the About screen paragraph, the secure-storage "Runtime boundary" sentence and the OTA env
  gotcha. All four get the 1.3.0 rewrite.

Rejected alternatives:
- **Runtime detection of the binary's schemes** (native build number via
  `requireOptionalNativeModule('ExpoApplication')`, branch `>= 31 ? 'hooplings' : 'bball-tracker'`):
  works but hard-codes a build number in app code, breaks for Android (separate versionCode, no
  Android builds exist yet), and leaves a trap for whoever next changes the scheme.
- **`scheme: ['bball-tracker', 'hooplings']` (old first) with no version bump:** old builds keep
  working via manifestSchemes[0], but new builds also sign in via `bball-tracker://`, which fails
  the issue's "a fresh build signs in via `hooplings://`" criterion.
- **`Linking.canOpenURL('hooplings://')` probe:** iOS returns false for schemes not in
  `LSApplicationQueriesSchemes`; not a reliable self-check.

### D-B  Register both schemes natively during the overlap

`scheme: ['hooplings', 'bball-tracker']` (Expo accepts an array; `collectManifestSchemes` handles
it). Build #31+ answers both, so any `bball-tracker://` link still around (a Notes-app paste, an
old doc) opens the new build. **Verified end to end:** native registration only gets the URL
delivered; routing is expo-router, whose `fromDeepLink` in
`node_modules/expo-router/build/fork/extractPathFromURL.js` strips any scheme via `new URL()`
host + pathname, so `bball-tracker://teams` and `hooplings://teams` reach the same route. That is
the whole justification for carrying the second entry. Array order is **not** load-bearing once
D-C passes the scheme explicitly; `hooplings` goes first only so the dev-only "multiple schemes"
warning names the current one.

### D-C  Sign-in passes the scheme explicitly

`login.tsx`: `Linking.createURL('auth/callback', { scheme: APP_URL_SCHEME })` with
`export const APP_URL_SCHEME = 'hooplings'` in `mobile/config/env.ts`, next to `getApiUrl()`
(the "decided in ONE place" pattern from #502). Explicit avoids the dev-only "multiple possible
URI schemes" warning and makes the redirect independent of array order. The web invite page
cannot import from `mobile/`, so it keeps its own literal (`hooplings://invite/…`); there is no
shared package between `web/` and `mobile/` today and adding one for a single string is not
worth it.

### D-D  The overlap list has ONE home: the task definition (eng review 3A)

- `routes.ts` default becomes `'hooplings'` only. The code default describes the product; the
  transition belongs to production, the only place old binaries exist. A developer on an old dev
  client gets a 400 until they rebuild, which checking out this branch forces anyway (the scheme
  is native).
- `infra/task-definition.json`: `ALLOWED_REDIRECT_SCHEMES=hooplings,bball-tracker` explicitly
  (#53 rule: env changes go in the JSON). The dated follow-up edits this one line.
- **Production runs on the code default today** (`ALLOWED_REDIRECT_SCHEMES` is unset), so the
  default change and the task-definition line **must land in the same commit**, with the tests
  below in that commit: a green CI on an intermediate commit still deploys, and a missing or
  misspelled JSON line would 400 every installed build's sign-in.
- `tests/infra/task-definition.test.ts`: contains `hooplings`; contains `bball-tracker` with a
  comment naming the follow-up and its date so the assertion is deleted with it; every entry
  matches `^[a-z][a-z0-9+.-]*$` (RFC 3986 scheme grammar, lower-case).
- `tests/api/auth.test.ts`: `bball-tracker://auth/callback` accepted when
  `ALLOWED_REDIRECT_SCHEMES` is set to the value **read from the JSON** (the `cors.test.ts`
  pattern), so the deploy file and the route are tested together.

### D-E  Overlap removal is a dated follow-up issue

TestFlight builds expire 90 days after upload. Build #30 was uploaded 2026-08-29, so the last
pre-rename binary dies on 2026-11-27. The follow-up is dated **2026-12-01** and removes, in this
order of importance:
- `bball-tracker` from `ALLOWED_REDIRECT_SCHEMES` in the task definition (+ its test line) and the
  WorkOS Staging `bball-tracker://auth/callback` URI — these exist only for sign-in from an old
  binary, which the expiry date bounds.
- The second `scheme` array entry and the brand-guard "kept identifier" comment. Links do not
  expire, but after PR B there is no source of `bball-tracker://` links (web rewritten and not
  deployed, Maestro and docs rewritten), so the entry serves nothing. It needs a native build to
  remove and nobody cuts one for that alone: **it rides whatever native build follows 2026-12-01.**

If another 1.2.0 build is cut before PR B merges, the date moves to 90 days after that upload.

### D-F  Web invite page emits `hooplings://`

Pre-rename builds will not answer it. Acceptable: the web app is not deployed (#30), so no link is
in anyone's hands, and Universal Links (`hooplings.com/invite/<token>`) are the primary path.

### D-G  Brand guard retires the link form now (eng review 2A, 4B)

`mobile/__tests__/i18n/brand-guard.test.ts` gains `/bball-tracker:\/\//` in
`RETIRED_BRAND_PATTERNS`. Bare `bball-tracker` (EAS slug, scheme array entry) and
`com.bballtracker.mobile` stay allowed; the self-test asserts all three cases (so
`mobile/__tests__` will always carry the retired literal — verify greps exclude it). The source
scan also walks `web/app` (4B: `web/` has no test runner, and this is the one file that emits a
scheme to real browsers once #30 ships; `test-mobile` in `ci.yml` has no path filter, so a
web-only PR is scanned too). That scan trips on the placeholder App Store URLs, fixed in D-H.

### D-H  Web store links use the real App Store Connect id (eng review 5A, 12B)

`web/app/page.tsx:10` and `invite-client.tsx:40` become `https://apps.apple.com/app/id6758903514`
— the id-only form Apple resolves, taken from `mobile/eas.json` `submit.production.ios.ascAppId`.
Until the app is released that page shows Apple's "not available" notice rather than a 404 for a
fake id, and it becomes correct on release day with no flip. The pre-release behaviour of the
button (TestFlight link or hide) is a **deploy-time decision owned by #30**, noted there. The Play
Store placeholder carries no retired name and stays (no Android app exists; also noted on #30).

## Rollout: two PRs, build before merge (eng review 11A)

```
PR A  backend + infra (allowlist)                        PR B  mobile + web + Maestro + docs
──────────────────────────────────                       ────────────────────────────────────
1. WorkOS Staging: add hooplings://auth/callback          4. Branch carries version 1.3.0, scheme array,
   keep the old URI                          [human]         explicit scheme, guard, web, docs
2. routes.ts default 'hooplings'; task-def                5. eas build --platform ios --profile production
   ALLOWED_REDIRECT_SCHEMES=hooplings,bball-tracker;         FROM THE BRANCH → build #31 → TestFlight  [human]
   both tests in the SAME commit                          6. Verify on device against production:
3. Merge → ECS deploys → harmless to every                   #31 signs in via hooplings://
   installed build (both accepted)                           #30 still signs in via bball-tracker://
        │                                                 7. Merge PR B (runtime 1.3.0 now has a binary;
        └────────── PR A deployed ──────────────────────▶    no OTA freeze ever existed)
                                                          8. File the dated follow-up (D-E, 2026-12-01)
```

Why this order: build #31 can only be verified once production accepts `hooplings://`, which
happens when PR A deploys; and 1.2.0 devices keep their OTA path until PR B merges, by which time
#31 exists. If step 1 is skipped, step 6 fails on #31 with WorkOS's own "Invalid redirect URI"
page; adding the URI fixes it without a rebuild. #24 (WorkOS Production keys) registers
`hooplings://auth/callback` **only**, so the production environment never carries the overlap.

## Changes

PR A — backend + infra
- `backend/src/api/auth/routes.ts`: default `'hooplings'`.
- `infra/task-definition.json`: `ALLOWED_REDIRECT_SCHEMES`.
- `backend/tests/api/auth.test.ts`, `backend/tests/infra/task-definition.test.ts` (same commit).
- `backend/env.example`, `backend/docs/workos-setup-steps.md`, `docs/deployment/aws-setup.md`.

PR B — mobile + web + E2E + docs
- `mobile/app.config.js`: `scheme` array, `version: '1.3.0'`, comment block.
- `mobile/config/env.ts`: `APP_URL_SCHEME`. `mobile/app/login.tsx`: explicit scheme; comment.
- Comments: `app/auth/callback.tsx`, `app/invite/[token].tsx`, `utils/pkce.ts`, `app/about.tsx`,
  `services/secure-storage.ts`.
- Tests: `__tests__/app-config.test.ts`, `__tests__/app/login.test.tsx`,
  `__tests__/i18n/brand-guard.test.ts`, `__tests__/utils/return-path.test.ts`,
  `__tests__/app/about.test.tsx` (fixture versions).
- `web/app/invite/[token]/invite-client.tsx`, `web/app/page.tsx`.
- `.maestro/auth-callback.yaml`, `.maestro/coach-onboarding.yaml`.
- `CLAUDE.md` (overview sentence; four 1.2.0 paragraphs → 1.3.0; dev-client rebuild gotcha;
  Maestro note that scheme links need a client built from a branch that registers them),
  `docs/testing/e2e-test-plan-v2.0.md`, `docs/testing/workos-test-accounts.md` (`://` literals only).

## Test plan (eng review, section 3)

Every branch below ships with the code, not after it. Regressions are marked **CRITICAL**.

Backend `tests/api/auth.test.ts` (PR A; env is read inside the handler, so set/restore
`process.env.ALLOWED_REDIRECT_SCHEMES` per test):
- `hooplings://auth/callback` accepted with env unset (new default) — forwards to WorkOS.
- **CRITICAL** `bball-tracker://auth/callback` → **400** with env unset (default no longer lists
  it; the existing PKCE test at :157 uses this literal and must switch to `hooplings://`).
- env = the exact `ALLOWED_REDIRECT_SCHEMES` value read from `infra/task-definition.json` →
  both schemes accepted (binds the test to the deploy file the way `cors.test.ts` does).
- env = `' hooplings , bball-tracker '` → whitespace trimmed, both accepted.
- `myapp://callback` → 400 (existing, keep).
- `redirect_uri=not a url` → 400 `malformed URL` (existing branch at routes.ts:184, never tested).

Backend `tests/infra/task-definition.test.ts` (PR A, same commit as the default change):
- `ALLOWED_REDIRECT_SCHEMES` present; contains `hooplings`; contains `bball-tracker` (comment:
  "overlap until the dated follow-up; delete this line with it"); every entry matches
  `^[a-z][a-z0-9+.-]*$`.

Mobile `__tests__/app-config.test.ts` (PR B):
- `expo.scheme` equals `['hooplings', 'bball-tracker']`.
- `expo.scheme` includes `APP_URL_SCHEME` from `config/env.ts` (cross-file: the redirect the app
  asks for is a scheme the binary registers).
- `expo.version` is ≥ `1.3.0` by semver compare, with the comment naming the OTA boundary.

Mobile `__tests__/app/login.test.tsx` (PR B):
- **CRITICAL** mock `createURL` honours `options.scheme`; assert
  `createURL('auth/callback', { scheme: 'hooplings' })` and
  `redirect_uri: 'hooplings://auth/callback'` in the `/auth/login` params.

Mobile `__tests__/i18n/brand-guard.test.ts` (PR B):
- `findRetiredBrand('bball-tracker://auth/callback')` defined; `'bball-tracker'` (bare) and
  `'com.bballtracker.mobile'` undefined; the walk now also covers `web/app` (skip `web/node_modules`,
  `web/.next`) and the existing "no offenders" assertion runs over it.
- `__tests__/utils/return-path.test.ts:44` fixture → `hooplings://x` (same assertion).
- `__tests__/app/about.test.tsx` fixtures → `1.3.0` / build 31.

Maestro (manual, `npx prisma db seed` before each; requires `npx expo run:ios` from PR B's branch
because the scheme is native — an older dev client does not register `hooplings://`):
- `.maestro/auth-callback.yaml` with `hooplings://auth/callback?error=access_denied`.
- `.maestro/coach-onboarding.yaml` with `hooplings://teams` and `hooplings://games`.
- Old-link check on the **rebuilt dev client** (a TestFlight binary cannot run on a simulator):
  `xcrun simctl openurl booted "bball-tracker://teams"` opens the Teams screen.

On device after build #31 (rollout step 6; recorded in `docs/testing/e2e-test-plan-v2.0.md` A.2):
- Build #31 signs in; the WorkOS redirect lands on the callback screen via `hooplings://`.
- Build #30 (still on the last 1.2.0 OTA) signs in via `bball-tracker://` against the deployed
  backend (proves the task-definition overlap).
- On the physical device with #31, a `bball-tracker://teams` link pasted in Notes opens the app.

## Failure modes (new code paths)

| Path | Realistic failure | Test | Handling | User sees |
| --- | --- | --- | --- | --- |
| login.tsx explicit scheme | `hooplings` removed from the array in a later edit | app-config cross-file test | none at runtime | dead redirect; caught in CI |
| Backend allowlist default (PR A) | task-def line missing/misspelled → prod falls to `hooplings` only while every binary is 1.2.0 | task-definition test + auth test bound to the JSON, same commit | 400 `host not allowed` | old builds: "Sign in failed"; caught in CI before deploy |
| WorkOS URI not added before build #31 | operator skips rollout step 1 | none possible | WorkOS renders its own error page in the browser | recoverable by adding the URI, no rebuild |
| Old dev client on the simulator after checking out PR B | Metro emits `hooplings://`, binary lacks it | Maestro fails at `openLink` | none | after step 1: sign-in bounces to Safari; before step 1: WorkOS error page. Fix `npx expo run:ios` (documented in CLAUDE.md) |
| Web store fallback | Apple listing not yet public | none | none | Apple's "not available" page until approval (deploy-time choice on #30), never a 404 for a fake id |

No failure mode is untested AND unhandled AND silent: the WorkOS-URI case is loud (WorkOS error
page), the dev-client case is loud (Safari or WorkOS page), and the two CI-caught cases fail the
build before deploy. **0 critical gaps.** The "1.2.0 OTA published from this branch by mistake"
row from the first draft is gone: with the two-PR order there is no window in which `main`
targets a runtime without a binary.

## What already exists (reused, not rebuilt)

- Runtime boundary via `version` bump (audit #52, 1.1.0 → 1.2.0) — reused as-is (D-A).
- `config/env.ts` single-source pattern (#502) — extended with one constant (D-C).
- `tests/infra/task-definition.test.ts` (#507) and `cors.test.ts` reading the deploy file — extended (D-D).
- Brand guard walk + self-test (#431/#502) — extended with one pattern and one root (D-G).
- `.maestro/*` `openLink` + "Open" dialog handling — literal swap only.
- Expo's `scheme` array support, `expo-linking`'s `options.scheme`, expo-router's scheme-agnostic
  path extraction — platform features, no custom code.

## NOT in scope

- Bundle id / package name (never changes), EAS slug and repo rename (#505).
- Dropping the old scheme, the WorkOS old URI and the task-def overlap (dated follow-up, D-E).
- Android builds: none exist; the array registers both intent filters when one is cut.
- Web deploy (#30), a web test runner (#510), the Play Store placeholder and the pre-release
  behaviour of the store button (both noted on #30), and the AASA file (already names
  `hooplings.com`; no scheme in it).
- WorkOS Production environment (#24; carries a note to register the new URI only).
- Runtime detection of the binary's schemes (rejected, D-A).

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| PR A: backend default + auth tests + task-def + infra test + backend docs | `backend/`, `infra/`, `docs/deployment/` | — |
| PR B-1: mobile config + login + env constant + mobile tests + About/secure-storage comments | `mobile/` | — (merge after PR A deploys) |
| PR B-2: web store links + deep link | `web/app/` | — |
| PR B-3: brand guard pattern + web root | `mobile/__tests__/i18n/` | B-2 (guard must pass over the fixed web files) |
| PR B-4: Maestro flows + docs + CLAUDE.md | `.maestro/`, `docs/`, `CLAUDE.md` | B-1 (documents the final config) |

Lane A: PR A (independent, ships first). Lane B: B-1 → B-3 → B-4 (shared `mobile/`, sequential).
Lane C: B-2 (independent, must finish before B-3). Launch A, B, C in parallel; B-3 waits on C;
PR B merges only after PR A has deployed and build #31 is verified. In practice the whole change
is ~30 minutes of CC time, so a single sequential pass per PR is fine.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with
Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~15 min / CC: n/a)** — human — WorkOS Staging: add `hooplings://auth/callback`, keep the old URI
  - Surfaced by: Rollout step 1; outside voice 8 (also add to #24's checklist — done, comment posted)
  - Verify: WorkOS → Redirects lists both
- [ ] **T2 (P1, human: ~30 min / CC: ~5 min)** — PR A backend + infra — Allowlist default `hooplings`; overlap in the task definition only; tests in the same commit
  - Surfaced by: Code quality issue 3 (3A); outside voice 3 (sign-in cliff)
  - Files: `backend/src/api/auth/routes.ts`, `infra/task-definition.json`, `backend/tests/api/auth.test.ts`, `backend/tests/infra/task-definition.test.ts`, `backend/env.example`, `backend/docs/workos-setup-steps.md`, `docs/deployment/aws-setup.md`
  - Verify: `cd backend && npm test -- --testPathPattern="auth|task-definition"`; after merge, `aws ecs describe-services …` rollout COMPLETED and sign-in on build #30 still works
- [ ] **T3 (P1, human: ~30 min / CC: ~5 min)** — PR B mobile — Version 1.3.0, scheme array, explicit scheme, tests, About/secure-storage comment + fixture updates
  - Surfaced by: Architecture issue 1 (1A); outside voice 6 (collateral)
  - Files: `mobile/app.config.js`, `mobile/config/env.ts`, `mobile/app/login.tsx`, `mobile/app/about.tsx`, `mobile/services/secure-storage.ts`, `mobile/__tests__/app-config.test.ts`, `mobile/__tests__/app/login.test.tsx`, `mobile/__tests__/app/about.test.tsx`, `mobile/__tests__/utils/return-path.test.ts`
  - Verify: `cd mobile && npx jest __tests__/app-config.test.ts __tests__/app/login.test.tsx __tests__/app/about.test.tsx`
- [ ] **T4 (P1, human: ~20 min / CC: ~4 min)** — PR B brand guard — Retire the `bball-tracker://` link form; scan `web/app`
  - Surfaced by: Code quality issue 2 (2A), Test issue 4 (4B)
  - Files: `mobile/__tests__/i18n/brand-guard.test.ts`
  - Verify: `cd mobile && npx jest __tests__/i18n/brand-guard.test.ts`
- [ ] **T5 (P2, human: ~10 min / CC: ~2 min)** — PR B web — Deep link `hooplings://invite/…`; store links to `apps.apple.com/app/id6758903514`
  - Surfaced by: Test issue 5 (5A, 12B)
  - Files: `web/app/invite/[token]/invite-client.tsx`, `web/app/page.tsx`
  - Verify: `cd web && npm run lint && npm run build`; T4's guard passes
- [ ] **T6 (P2, human: ~30 min / CC: ~5 min)** — PR B E2E + docs — Maestro literals, CLAUDE.md (overview, four 1.2.0 paragraphs, dev-client rebuild gotcha), docs `://` literals, comments
  - Surfaced by: Step 0 scope (A); Failure modes (old dev client); outside voice 6, 9
  - Files: `.maestro/auth-callback.yaml`, `.maestro/coach-onboarding.yaml`, `CLAUDE.md`, `docs/testing/e2e-test-plan-v2.0.md`, `docs/testing/workos-test-accounts.md`, mobile comment files
  - Verify: brand guard green; `grep -rn "bball-tracker://" --exclude-dir=node_modules --exclude-dir=__tests__ . | grep -v "^./docs/plans/"` returns nothing
- [ ] **T7 (P1, human: ~20 min / CC: ~5 min)** — human + CC — Cut build #31 from the PR B branch, verify both builds sign in against production, then merge PR B and file the dated follow-up (2026-12-01)
  - Surfaced by: Rollout 11A; D-E; issue "Done when"
  - Verify: on-device checks in the test plan; `gh issue list` shows the follow-up; update the build/OTA memory note

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found (Claude subagent fallback, Codex not installed) | 13 findings, 3 cross-model tensions, all resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 22 issues (5 review + 17 test gaps, 2 regressions marked critical), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** Outside voice (same model family, fresh context) agreed with the design and
  challenged the rollout: build before merge (accepted, amended to two PRs, 11A); store link
  dead until release (kept 5A, deploy-time note on #30, 12B); D-E date does not apply to the
  array entry (accepted, rides the next native build after 2026-12-01). Ten further corrections
  folded (13A): motivation reframed as identifier hygiene, same-commit tests for the allowlist,
  simulator check moved to the dev client, expo-router verification recorded, 1.3.0 collateral
  listed, verify grep excludes `__tests__`, docs sweep is `://`-only, array order not load-bearing,
  dev-client failure row corrected, #24 checklist note posted.
- **VERDICT:** ENG CLEARED — ready to implement (two PRs; PR A first).

NO UNRESOLVED DECISIONS
