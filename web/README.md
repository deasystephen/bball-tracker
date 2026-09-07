# Hooplings Web

Next.js web app served at `https://hooplings.com`. Hosts the public invitation accept flow (`/invite/<token>`) that emails link to and the `.well-known/` Universal Link assets that route into the mobile app when installed.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **React**: 19
- **Language**: TypeScript
- **Hosting**: TBD (Vercel/CloudFront — not yet deployed as of 2026-06-14)

## Setup

### Prerequisites
- Node.js 22+

### Install & run
```bash
npm install
npm run dev     # http://localhost:3000
npm run lint
npm run build   # production build
```

## Routes

| Path | Purpose |
|---|---|
| `/` | Marketing landing (minimal placeholder) |
| `/invite/<token>` | Public invitation accept page. Fetches token state from the backend, deep-links to the mobile app via Universal Links, falls back to web accept if the app isn't installed. |
| `/.well-known/apple-app-site-association` | iOS Universal Link assoc. **Team ID `2JV3V89598`** wired in #138. |
| `/.well-known/assetlinks.json` | Android Universal Link assoc. Placeholder fingerprint — tracked in #139 until Android signing is set up. |

## How the invite flow works

1. Coach creates invitation → backend (#131 mailer) sends an email with a link to `https://hooplings.com/invite/<token>`.
2. Recipient taps the link:
   - **iOS with app installed** → Universal Link routes directly into `mobile/app/invite/[token].tsx`.
   - **Android with app installed (after Android signing setup, #139)** → same.
   - **No app installed / desktop** → this Next.js page renders. Token state (PENDING / EXPIRED / ACCEPTED / etc.) is fetched from `backend/src/api/invitations/public-routes.ts`. User can accept inline or get the App Store / Play Store link.

## Configuration

Two API-host variables, both defaulting to `http://localhost:3000`:
- `API_URL` — read server-side by `app/invite/[token]/page.tsx` for the invitation lookup (`GET /invitations/by-token/:token`).
- `NEXT_PUBLIC_API_URL` — inlined into the browser bundle **at build time** for the Accept button in `invite-client.tsx` (`POST …/accept`). Set it before `npm run build`; a runtime env change does not reach the client.

If `API_URL` is wrong the page swallows the fetch failure and renders "Invitation Not Found" for every token, so check it first when debugging. Running against a local backend also needs the web dev origin in the backend's `CORS_ORIGIN` (see `backend/env.example`).

In production both point at `https://api.hooplings.com`, and:
- The backend's `CORS_ORIGIN` must list this site's origin(s) (`https://hooplings.com`, `https://www.hooplings.com`) or the Accept button fails its CORS preflight (#447) — see `infra/task-definition.json`.
- The backend's `PUBLIC_APP_URL` must point at this site (`https://hooplings.com`) so invitation emails embed the right CTA URL — see `backend/env.example`.

## Tests

No test framework configured yet. Tracked in #51 follow-up; bootstrap Vitest + RTL before adding more interactive flows.

## Related

- Backend invite endpoints: `backend/src/api/invitations/public-routes.ts`
- Backend mailer + template: `backend/src/services/mailer/templates/invitation.ts`
- Mobile counterpart screen: `mobile/app/invite/[token].tsx`
- Issue tracking the Android fingerprint: #139
