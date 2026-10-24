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
| 2a | Link opened in the app | API log | the same line with `@client:ios\/*` or `@client:android\/*` (Datadog needs the `/` escaped). **Not yet populated:** the app sends `X-Hooplings-Client` only once the mobile side of #963 ships (with #967); until then its lookups log `@client:unknown`, the value for any caller without a valid header |
| 3 | "Open in App" from the web page | App event (Amplitude) | **Not built yet (#967).** The web half shipped with #964: the deep link carries `?src=web`. The app's invite screen is to report it as `invite_link_viewed` with `source = web`; until #967 adds that event to `docs/architecture/analytics.md`, this step has no data |
| 4 | Accepted on the web, without the app | API log | `service:bball-tracker-api ("Invitation accepted" OR "Guardian linked") @via:token`. These lines also carry `@client:web`, inherited from the request's log context (`backend/tests/api/correlation-headers.test.ts` pins that a line written inside a request carries the client). `Guardian linked` is written after the transaction commits, so a rolled-back accept is never counted |
| 4a | Accepted in the app | API log + Amplitude | the same lines with `@via:app`; Amplitude `invitation_accepted` (`source`: `in_app` / `link`) |
| 5 | First sign-in claiming the invite | Amplitude | `user_logged_in` with `claimed_invite = true` (#790) |

**Read step 2 with care.** The page is server-rendered, so anything that fetches the link logs a
view: email security scanners (Outlook Safe Links, corporate gateways) and link-preview fetchers
(iMessage, Slack) often do so within seconds of `Invitation sent`, with no person present, and they
log as `client: web, state: pending` like a person would. The site forwards nothing about the
visitor (no user agent, no IP), so the line cannot tell them apart. Treat step 2 as an upper bound,
and use the accepts (step 4), which need a click, as the reliable web signal. A view seconds after
the send, with no accept, is most likely a scanner.

Failures between the steps, already logged: a 400/404/429/5xx lookup is the API's `HTTP request` line
for `/api/v1/invitations/by-token/[redacted]` (`@statusCode`), and the web server logs
`Invitation lookup unavailable` (`service:bball-tracker-web`, `docs/deployment/web-app.md`). A failed
"Accept without app" is the API's `HTTP request` line for `…/[redacted]/accept` with `@client:web`.

## The lines (as built)

- **`Invitation viewed by token`** (`backend/src/api/invitations/public-routes.ts`, the
  `GET /invitations/by-token/:token` route, info): `invitationId`, `kind`, `state`, `client`.
  It is logged once per **successful** lookup, never for a 400 or 404. `state` is the stored status,
  lower-cased, except that a PENDING row past its `expiresAt` reads as `expired`, which is what the
  page and the app show (`invitationViewState`, an exhaustive switch over `InvitationStatus`, so a
  new status fails to compile). `client` is the validated `X-Hooplings-Client`, or `unknown`
  without a valid one (a searchable value; Datadog cannot search a JSON null). The header contract
  is in `backend-services.md#logging`. No token, team name, child name
  or message. Pinned by `backend/tests/api/invitations-public.test.ts` ("Invitation viewed by token").
- **`Invitation accepted`** carries `via: 'token' | 'app'` (it already did). **`Guardian linked`**
  gains the same `via` (`GuardianService.accept`: a verified caller is `app`, the public by-token
  accept is `token`), so guardian accepts by link and in the app can be told apart. It is now
  logged after the transaction commits, not inside it, because the funnel counts it
  (`backend/tests/services/guardian-service.test.ts`).
- **The web site identifies itself**: `web/lib/api-urls.ts#CLIENT_HEADERS` (`X-Hooplings-Client: web`)
  is sent on the server-side lookup (`web/lib/invitation-lookup.ts`) and on the browser's accept
  (`web/lib/invitation-accept.ts`, called by `app/invite/[token]/invite-client.tsx`); both are
  asserted on the real `fetch` call (`web/__tests__/invite-page.test.tsx`,
  `invitation-accept.test.ts`). The API's CORS preflight allows the header
  (`backend/tests/api/cors.test.ts`).
- **The deep link**: `web/lib/open-in-app.ts#inviteDeepLink` is `hooplings://invite/<token>?src=web`.
  Expo Router passes `src` to `mobile/app/invite/[token].tsx` as its own search param, so the
  screen's `token` param is unchanged. When the visitor is signed out, the app stores the return
  path `/invite/<token>` without `src` and brings them back to the same screen after sign-in, so
  the screen mounts twice for one arrival. #967 has to count that return as the same arrival (for
  example, report `invite_link_viewed` once per token per app session, or keep `src` in the return
  path), or step 3 double-counts web arrivals.

## Datadog saved view (created by hand)

Datadog is not managed from this repository and the session MCP cannot write. To create the view:
Logs → Explorer, query
`service:bball-tracker-api env:production ("Invitation sent" OR "Guardian invitation sent" OR "Invitation viewed by token" OR "Invitation accepted" OR "Guardian linked")`,
visualise as **Top list** grouped by `message`, then `@client`, then `@state` / `@via`. In a
query, escape the `/` of an app client (`@client:ios\/1.6.0*`). Make
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
