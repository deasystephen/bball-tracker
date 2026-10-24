# Invite funnel: measured from the server (#964, Option A)

How the invitation funnel is measured with **no analytics in the browser**. The owner chose Option A
on 2026-10-24: hooplings.com loads no analytics SDK and sets no cookie, so the privacy policy's
section 11 ("The hooplings.com pages set no cookies and run no analytics") stays true. Every step is
either an API log line in Datadog or an app event in Amplitude. Option B (Amplitude Browser) was not
chosen; its required configuration is written up in #964 if that ever changes.

## The steps

| # | Step | Where | Query or event |
| --- | --- | --- | --- |
| 1 | Invitation sent | API log (Datadog) | `service:bball-tracker-api env:production ("Invitation sent" OR "Guardian invitation sent")`. A resend also logs `Invitation superseded` |
| 2 | Link opened on the web | API log | `service:bball-tracker-api "Invitation viewed by token" @client:web`. Group by `@state` (`pending`, `expired`, `accepted`, `rejected`, `cancelled`) and `@kind` (`team`, `guardian`). Count unique `@invitationId` for invitations rather than page loads |
| 2a | Link opened in the app | API log | the same line with `@client:ios/*` or `@client:android/*` (the app's own lookup, `mobile/hooks/useInvitationByToken.ts`). `@client:null` marks a caller that sent no valid `X-Hooplings-Client` |
| 3 | "Open in App" from the web page | App event (Amplitude) | `invite_link_viewed` with `source = web`, sent by the app's invite screen when the deep link carries `?src=web` (#967; the web half, the `?src=web`, shipped with #964) |
| 4 | Accepted on the web, without the app | API log | `service:bball-tracker-api ("Invitation accepted" OR "Guardian linked") @via:token`. These lines also carry `@client:web`, inherited from the request's log context |
| 4a | Accepted in the app | API log + Amplitude | the same lines with `@via:app`; Amplitude `invitation_accepted` (`source`: `in_app` / `link`) |
| 5 | First sign-in claiming the invite | Amplitude | `user_logged_in` with `claimed_invite = true` (#790) |

Failures between the steps, already logged: a 400/404/429/5xx lookup is the API's `HTTP request` line
for `/api/v1/invitations/by-token/[redacted]` (`@statusCode`), and the web server logs
`Invitation lookup unavailable` (`service:bball-tracker-web`, `docs/deployment/web-app.md`). A failed
"Accept without app" is the API's `HTTP request` line for `…/[redacted]/accept` with `@client:web`.

## The lines (as built)

- **`Invitation viewed by token`** (`backend/src/api/invitations/public-routes.ts`, the
  `GET /invitations/by-token/:token` route, info): `invitationId`, `kind`, `state`, `client`.
  It is logged once per **successful** lookup, never for a 400 or 404. `state` is the stored status,
  lower-cased, except that a PENDING row past its `expiresAt` reads as `expired`, which is what the
  page and the app show (`invitationViewState`). `client` is the validated `X-Hooplings-Client`, or
  `null` (the header contract is in `backend-services.md#logging`). No token, team name, child name
  or message. Pinned by `backend/tests/api/invitations-public.test.ts` ("Invitation viewed by token").
- **`Invitation accepted`** carries `via: 'token' | 'app'` (it already did). **`Guardian linked`**
  gains the same `via` (`GuardianService.accept`: a verified caller is `app`, the public by-token
  accept is `token`), so guardian accepts by link and in the app can be told apart
  (`backend/tests/services/guardian-service.test.ts`).
- **The web site identifies itself**: `web/lib/api-urls.ts#CLIENT_HEADERS` (`X-Hooplings-Client: web`)
  is sent on the server-side lookup (`web/lib/invitation-lookup.ts`) and on the browser's accept
  (`web/app/invite/[token]/invite-client.tsx`). The API's CORS preflight allows the header
  (`backend/tests/api/cors.test.ts`).
- **The deep link**: `web/lib/open-in-app.ts#inviteDeepLink` is `hooplings://invite/<token>?src=web`.
  Expo Router passes `src` to `mobile/app/invite/[token].tsx` as its own search param, so the
  screen's `token` param is unchanged. The stored post-login return path (`/invite/<token>`) drops
  `src` on purpose: it is a navigation target, not a second arrival.

## Datadog saved view (created by hand)

Datadog is not managed from this repository and the session MCP cannot write. To create the view:
Logs → Explorer, query
`service:bball-tracker-api env:production ("Invitation sent" OR "Guardian invitation sent" OR "Invitation viewed by token" OR "Invitation accepted" OR "Guardian linked")`,
visualise as **Top list** grouped by `message`, then `@client`, then `@state` / `@via`. Make
`@client`, `@state`, `@kind` and `@via` facets (Datadog offers this from a line's attribute panel).
Save the view as **Invite funnel (server-side)**. For a time series, use the same query as a
**Timeseries** with "count unique of `@invitationId`" grouped by `message`.

Note that log retention is 15 days (the org's default index), so this view answers "how is the
funnel doing this fortnight". For anything longer, use a Datadog log-based metric on the same
query, or the Amplitude steps.

## Privacy

Nothing new leaves our systems. These are API log lines, covered by the "Server logs" paragraphs of
the privacy policy and `docs/runbooks/data-subject-requests.md` ("Retention"). `client` is an app
version or `web`, not a user or device identifier. The web page itself still runs no analytics.
