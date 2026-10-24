# Hooplings Web

Next.js web app served at `https://hooplings.com`. Hosts the public invitation accept flow (`/invite/<token>`) that emails link to and the `.well-known/` Universal Link assets that route into the mobile app when installed.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **React**: 19
- **Language**: TypeScript
- **Hosting**: AWS ECS Fargate behind the API's ALB (`infra/web.tf`, `web/Dockerfile`), deployed by CI's `build-and-deploy-web` job (#30). Bring-up, routing and deploys: `docs/deployment/web-app.md`

## Setup

### Prerequisites
- Node.js 22 (the root `.nvmrc`; CI uses it)

### Install & run
```bash
npm install
npm run dev     # http://localhost:3000
npm run lint        # ESLint CLI, --max-warnings 0
npm run type-check  # tsc --noEmit
npm run build       # production build only: it skips lint and type errors, run the two above
```

## Routes

| Path | Purpose |
|---|---|
| `/` | Marketing landing (minimal placeholder) |
| `/support` | Support page, the App Store Support URL (#450). The address is `lib/site.ts#SUPPORT_EMAIL`, pinned equal to the backend's and the app's |
| `/privacy`, `/terms` | Privacy policy and terms of service, added by the #25 pages PR; the footer on every page links them, so that PR merges before the site goes live (`docs/deployment/web-app.md`, Bring-up) |
| `/health` | `{"status":"ok","commit":…}` for the ALB, container and uptime checks; never calls the API |
| `/invite/<token>` | Public invitation accept page. Fetches token state from the backend, deep-links to the mobile app via Universal Links, falls back to web accept if the app isn't installed. |
| `/.well-known/apple-app-site-association` | iOS Universal Link assoc. **Team ID `2JV3V89598`** wired in #138. |
| `/.well-known/assetlinks.json` | Android Universal Link assoc. Placeholder fingerprint — tracked in #139 until Android signing is set up. |

## How the invite flow works

1. Coach creates invitation → backend (#131 mailer) sends an email with a link to `https://hooplings.com/invite/<token>`.
2. Recipient taps the link:
   - **iOS with app installed** → Universal Link routes directly into `mobile/app/invite/[token].tsx`.
   - **Android with app installed** → same, once both halves of the App Links association exist: the real signing fingerprint in `assetlinks.json` (#139) and the app manifest's `autoVerify` https intent filter for `hooplings.com/invite/*` (`android.intentFilters` in `mobile/app.config.js`, #716, which ships only in a native build from runtime 1.6.0 on). Without the filter Android never consults `assetlinks.json` and opens Chrome. While the fingerprint half is missing, verification fails: Android 12+ opens the browser, but Android 6–11 shows the system app chooser for every `hooplings.com/invite/*` link.
   - **No app installed / desktop** → this Next.js page renders. Token state (PENDING / EXPIRED / ACCEPTED / etc.) is fetched from `backend/src/api/invitations/public-routes.ts`. User can accept inline. Until the App Store release the page says the app is coming soon instead of linking a store page that says "not available" (`APP_STORE_RELEASED` in `lib/open-in-app.ts`); no page links to Google Play while there is no Android listing.

## Configuration

Two API-host variables, both defaulting to `http://localhost:3000`:
- `API_URL` — read server-side by `app/invite/[token]/page.tsx` for the invitation lookup (`GET /invitations/by-token/:token`).
- `NEXT_PUBLIC_API_URL` — inlined into the browser bundle **at build time** for the Accept button in `invite-client.tsx` (`POST …/accept`). Set it before `npm run build`; a runtime env change does not reach the client.

The page tells a dead link from a failed lookup (`lib/invitation-lookup.ts`, #720): a 400 or 404 renders "Invitation Not Found" with the ask-the-coach-to-resend footer; a 429, a 5xx, an unreadable body or a failed fetch renders "Invitation Temporarily Unavailable" (with wait copy for a 429, worded for either the per-token or the per-IP limiter) and **no** resend advice, because a resend supersedes the token and kills a link that was still valid. The server logs `Invitation lookup unavailable` with a `reason` (`network`, `status` or `body`) and the status, never the URL or the token. Both by-token URLs (lookup and accept) are built in `lib/api-urls.ts`, with the token encoded; the payload types live in `lib/invitation-types.ts`. Expiry dates render through `lib/format-date.ts` in a fixed locale and UTC, so the server render and the browser hydrate the same text. If `API_URL` is wrong every token renders the unavailable card, so check it first when debugging. Running against a local backend also needs the web dev origin in the backend's `CORS_ORIGIN` (see `backend/env.example`).

In production both point at `https://api.hooplings.com`, and:
- The backend's `CORS_ORIGIN` must list this site's origin(s) (`https://hooplings.com`, `https://www.hooplings.com`) or the Accept button fails its CORS preflight (#447) — see `infra/task-definition.json`.
- The backend's `PUBLIC_APP_URL` must point at this site (`https://hooplings.com`) so invitation emails embed the right CTA URL — see `backend/env.example`.

## Tests

```bash
npm test   # Vitest (vitest.config.mts), node environment, files in __tests__/
```

Vitest (#510) runs in the node environment: `lib/open-in-app.ts` takes its browser surface (user agent, `document`, navigation) as an argument, and pages are rendered with `react-dom/server`, so no DOM library is installed. `__tests__/open-in-app.test.ts` pins the `hooplings://invite/<token>` deep link and the store fallback (App Store on iOS once released, including iPadOS 13+ which sends a Macintosh UA and is told apart by `maxTouchPoints`; never before the release; never on Android or desktop; only when the page never hid); `__tests__/site.test.tsx` covers the support page, the footer, the pre-release store copy and `/health`; `__tests__/invite-page.test.tsx` covers the lookup states and the tombstoned inviter and child labels. CI runs lint and type-check in the `lint-and-typecheck` matrix, and `npm test` then the production build in the `Test Web` job (`.github/workflows/ci.yml`). `mobile/__tests__/i18n/brand-guard.test.ts` also scans `web/app` and `web/lib` for retired brand names.

The inviter on the accept page goes through `lib/display-name.ts#inviterDisplayName` (and the child through `childDisplayName`), both built on `displayName`, which mirrors the mobile helper: when `inviterDeletedAt` is set it shows the "Deleted user" label from `lib/strings.ts`, never the stored name (#814). Both payload kinds carry `inviterDeletedAt`, and the guardian kind also carries `childDeletedAt`, which labels the child the same way (#894). `__tests__/strings.test.ts` pins the label equal to mobile's `account.deletedUser`.

## Related

- Backend invite endpoints: `backend/src/api/invitations/public-routes.ts`
- Backend mailer + template: `backend/src/services/mailer/templates/invitation.ts`
- Mobile counterpart screen: `mobile/app/invite/[token].tsx`
- Issue tracking the Android fingerprint: #139
