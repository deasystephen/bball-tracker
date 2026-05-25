# Basketball Tracker Web

Next.js web app served at `https://capyhoops.com`. Hosts the public invitation accept flow (`/invite/<token>`) that emails link to and the `.well-known/` Universal Link assets that route into the mobile app when installed.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **React**: 19
- **Language**: TypeScript
- **Hosting**: TBD (Vercel/CloudFront — not yet deployed as of 2026-05-25)

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

1. Coach creates invitation → backend (#131 mailer) sends an email with a link to `https://capyhoops.com/invite/<token>`.
2. Recipient taps the link:
   - **iOS with app installed** → Universal Link routes directly into `mobile/app/invite/[token].tsx`.
   - **Android with app installed (after Android signing setup, #139)** → same.
   - **No app installed / desktop** → this Next.js page renders. Token state (PENDING / EXPIRED / ACCEPTED / etc.) is fetched from `backend/src/api/invitations/public-routes.ts`. User can accept inline or get the App Store / Play Store link.

## Configuration

No env vars required for local dev. In production:
- The backend's `PUBLIC_APP_URL` must point at this site (`https://capyhoops.com`) so invitation emails embed the right CTA URL — see `backend/env.example`.

## Tests

No test framework configured yet. Tracked in #51 follow-up; bootstrap Vitest + RTL before adding more interactive flows.

## Related

- Backend invite endpoints: `backend/src/api/invitations/public-routes.ts`
- Backend mailer + template: `backend/src/services/mailer/templates/invitation.ts`
- Mobile counterpart screen: `mobile/app/invite/[token].tsx`
- Issue tracking the Android fingerprint: #139
