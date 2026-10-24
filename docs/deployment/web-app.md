# Web app: hosting, deploys and bring-up (#30)

The Next.js site in `web/` is served at `https://hooplings.com`. It hosts the invitation accept page
(`/invite/<token>`, the link in every invitation email), the support page (`/support`, the App Store
Support URL), the privacy and terms pages (#25), and the `.well-known/` Universal Link files that
the iOS `applinks:hooplings.com` entitlement and Android App Links read.

## Where it runs

A second Fargate service on the API's cluster, behind the API's ALB (`infra/web.tf`):

| Piece | Value |
| --- | --- |
| Image | `web/Dockerfile` (Next.js `output: 'standalone'`), ECR repository `bball-tracker-web`, **immutable** commit tags, scan on push, last 20 images kept |
| Task definition | `infra/web-task-definition.json`, family `bball-tracker-production-web`; like the API's, owned by CI and never declared in Terraform |
| Service | `bball-tracker-production-web`, one task, 0.25 vCPU / 512 MiB, private subnets, its own security group (in from the ALB on 3000, out on 443 only; it cannot reach RDS or Redis) |
| Routing | HTTPS listener rules: `www.hooplings.com` → 301 to the apex (path and query kept); `hooplings.com` → the web target group. Every other host, `api.` included, falls through to the listener default, the API |
| DNS | Apex and `www` A aliases to the ALB. The certificate already listed the apex and the wildcard (`dns.tf`); CAA already allows only Amazon, which issued it |
| Health | `GET /health` → `{"status":"ok","commit":"<sha>"}`. It does not call the API, so it fails only when the site itself is down. ALB, container and a Route 53 uptime check (`web-uptime` alarm) all use it |
| Logs | `/ecs/bball-tracker-production-web`, 30 days. Our JSON lines (`web/lib/log.ts`) are also forwarded to Datadog; Next.js's own output is not. See [Logs and errors](#logs-and-errors) |

Why not Vercel or Amplify: invitation tokens are bearer secrets in the URL path, so a third-party host's
request logs would hold them, and the privacy policy would have to name another processor. One cloud,
one Terraform root, one CI.

## Logs and errors

Built in #966. The server writes through **`web/lib/log.ts`** only (ESLint `no-console` everywhere
in `web/` except that file): one JSON object per line, the API's shape,

```json
{"timestamp":"…","level":"warn","message":"Invitation lookup unavailable","reason":"status","status":503,"service":"bball-tracker-web","commit":"<40-hex sha>"}
```

`service` and `commit` (`GIT_COMMIT`, which the deploy job writes into the task definition; `null`
outside a deploy) come after the context, so no context key overrides them. Invitation links carry
**bearer tokens in the path**, so the logger runs the message and every string value through
`redactText` (the segment after `/invite/`, `/by-token/` or `/calendar/`, and secret-looking query
values such as `token=`, `code=`, `state=`, become `[redacted]`; a bracketed route pattern such as
`/invite/[token]` is kept) and masks a context key that names a secret (`token`, `authorization`, `code`, `state`, any
`…key`, …) whole. `timestamp`, `level`, `message`, `service` and `commit` are written after the
context, so a context key cannot overwrite them. Context is typed as flat ids, enums and numbers: an `Error` cannot be passed, so log its
`name`, never its message (undici's "Failed to parse URL from …" quotes the URL).
`web/__tests__/log.test.ts` proves a token in a message or a context value never reaches the output.

The lines:

| Message | Level | Fields | Where |
| --- | --- | --- | --- |
| `Invitation lookup unavailable` | warn | `reason` (`network`, `status`, `body`), `status` | `lib/invitation-lookup.ts`: the server-side lookup failed for a reason other than a dead link |
| `Web request error` | error | `method`, `routePath` (the **pattern**, e.g. `/invite/[token]`), `routeType`, `routerKind`, `renderSource`, `digest`, `errorName` | `instrumentation.ts#onRequestError`: any error Next.js catches while rendering a page or running a route handler. Never `request.path`, a header or the error's message |

**What reaches Datadog.** `infra/datadog.tf` subscribes the web log group to the forwarder with the
filter `{ $.service = "bball-tracker-web" }`, so only the lines above are forwarded, tagged
`env:production`. Next.js's own output (start-up lines, and its free-text error dump with the
stack and the same `digest`) stays in CloudWatch for 30 days; match a Datadog line to it by
`digest`. `backend/tests/infra/datadog-forwarding.test.ts` pins the filter to the logger's
service name.

Queries (Datadog US5, Logs):

- Everything from the site: `service:bball-tracker-web env:production`
- Server errors: `service:bball-tracker-web status:error` (group by `@routePath`, `@errorName`)
- A deploy's errors: `service:bball-tracker-web status:error @commit:<sha>`
- Lookups that failed: `service:bball-tracker-web "Invitation lookup unavailable"` (group by `@reason`, `@status`)

The browser has no logger and no error reporting (no web Sentry for launch, #966): a failed
"Accept without app" shows its message to the visitor and is seen as the API's `HTTP request`
line for `/api/v1/invitations/by-token/[redacted]/accept`.

**No analytics on the site (#964, Option A).** The page loads no analytics SDK and sets no cookie.
The invite funnel is measured server-side instead: the site sends `X-Hooplings-Client: web`
(`lib/api-urls.ts#CLIENT_HEADERS`) on the lookup and the accept, so the API's lines say `client:
web`, and "Open in App" opens `hooplings://invite/<token>?src=web`, which the app reports on
arrival. Queries: `docs/architecture/web-funnel.md`.

### Web error monitor (created by hand)

Datadog is not managed from this repository (no Datadog Terraform provider), so this monitor is
created in the Datadog UI: **Monitors → New Monitor → Import from JSON**, paste, save, then set
"Last edited" in the table in `docs/runbooks/on-call.md` (Datadog monitors). It fires when the
site logs any server error in 10 minutes; at launch traffic a single failed render is worth a
look. Raise the threshold here and in Datadog together if it gets noisy.

```json
{
  "name": "[hooplings.com] Web server errors",
  "type": "log alert",
  "query": "logs(\"service:bball-tracker-web env:production status:error\").index(\"*\").rollup(\"count\").last(\"10m\") > 0",
  "message": "hooplings.com logged {{value}} server error line(s) in 10 minutes.\n\nOpen the logs: service:bball-tracker-web status:error, grouped by @routePath and @errorName. Match a line to Next.js's own stack in CloudWatch (/ecs/bball-tracker-production-web) by @digest.\n\nRunbook: docs/runbooks/on-call.md#web-site-errors\n\n@alerts@hooplings.com",
  "tags": ["service:bball-tracker-web", "env:production", "team:hooplings"],
  "priority": 3,
  "options": {
    "thresholds": { "critical": 0 },
    "notify_no_data": false,
    "renotify_interval": 0,
    "include_tags": false,
    "enable_logs_sample": false,
    "notify_audit": false,
    "on_missing_data": "default",
    "groupby_simple_monitor": false
  }
}
```

`enable_logs_sample` stays `false` so the notification email carries a count, not log content.
The `web-uptime` CloudWatch alarm (`infra/web.tf`) stays the "site is down" signal; this monitor
is "the site is up and failing".

## Deploys

`build-and-deploy-web` in `.github/workflows/ci.yml` runs on a push to `main` that changes anything
non-Markdown under `web/` or `infra/web-task-definition.json`, and on every **Run workflow** by hand.
It builds the image with `NEXT_PUBLIC_API_URL=https://api.hooplings.com` (inlined into the browser
bundle at build time), pushes the commit tag, replaces `GIT_COMMIT_PLACEHOLDER`, registers the
revision and waits for the service to be stable (circuit breaker with rollback; minimum healthy
100%, so the old task serves until the new one passes). It then reads the commit off
`https://hooplings.com/health`.

- It has its own concurrency group: a web deploy never queues behind, or splits a live game like,
  an API deploy.
- `infra/web.tf` and `infra/web-task-definition.json` are excluded from the API's deploy filter
  (and from `.github/scripts/deploy-contents.sh`), so a web-only infra change does not roll the API.
- Dependabot's auto-merged `web/` bumps start no CI on `main`, as for the backend (#570); they ship
  with the next merge under `web/` or a run started by hand.
- Every PR builds the image too (the `Test Web` job), so a broken `web/Dockerfile` fails the PR.

Confirm what is live: `curl -s https://hooplings.com/health`.

**Rolling back.** The circuit breaker rolls back a revision that never becomes healthy. To go back
from one that is healthy but wrong, point the service at the previous revision; a run by hand
rebuilds the current `main`, which is the broken commit:

```bash
aws ecs list-task-definitions --family-prefix bball-tracker-production-web --sort DESC --max-items 3
aws ecs update-service --cluster bball-tracker-production-cluster --service bball-tracker-production-web \
  --task-definition bball-tracker-production-web:<previous revision>
```

Then revert the commit on `main`; its merge deploys the fix. A re-run, or a run by hand on a commit
that already shipped, reuses the image its tag names (tags are immutable).

## Store links before the App Store release

`APP_STORE_RELEASED` in `web/lib/open-in-app.ts` is `false` until the app is on the App Store
(#451). Until then no page links to the App Store (its page says "not available") and the
open-in-app fallback stays on the page; the copy says the app is coming soon. On release day,
flip it to `true` in a PR; the merge redeploys the site. There is no Android listing, so no page
links to Google Play (#139).

## Bring-up (two applies)

ECS cannot create a service until its family has a registered revision, and the first revision
comes from the first CI run. So `local.web_enabled` (top of `infra/web.tf`) gates the service, the
listener rules, the DNS records and the uptime alarm. It is a local in `web.tf`, not a variable, because
that file is outside the API's deploy filter: the PR that flips it does not roll the API or split
live games.

1. **Apply 1** (`local.web_enabled = false`): from `infra/`, `terraform plan` then `terraform apply`
   creates the ECR repository and lifecycle policy, the log group, the security group and the
   target group. Nothing is routed to them.
2. **Merge** the PR that carries `web.tf`. `build-and-deploy-web` builds, pushes and, finding no
   service, registers the first revision only ("registering the revision only" in the job summary).
3. **Apply 2**: first merge the privacy and terms pages (#25): the footer on every page links
   them. Then a PR that sets `web_enabled = true` in `infra/web.tf` and nothing else; apply from
   that branch, then merge it. The apply creates the service, the listener rules, the apex and `www` records and the
   uptime check. Then verify:
   ```bash
   curl -s https://hooplings.com/health                       # status ok, the commit
   curl -sI https://www.hooplings.com/support | grep -i location   # 301 to https://hooplings.com/support
   curl -sI https://hooplings.com/.well-known/apple-app-site-association | grep -i content-type   # application/json
   curl -s https://api.hooplings.com/health                   # the API still answers on its host
   ```
   Then open an invitation link on a phone with the app installed (Universal Link opens the app)
   and on a desktop (the accept page renders).

Turning the site off is `web_enabled = false` and an apply: the records, rules and service go;
the repository and its images stay.
