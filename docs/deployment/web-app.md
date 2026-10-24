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
| Logs | `/ecs/bball-tracker-production-web`, 30 days, not forwarded to Datadog. Next.js logs no request URLs in production; the one app line is `Invitation lookup unavailable` with a reason and status, never the token |

Why not Vercel or Amplify: invitation tokens are bearer secrets in the URL path, so a third-party host's
request logs would hold them, and the privacy policy would have to name another processor. One cloud,
one Terraform root, one CI.

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

## Store links before the App Store release

`APP_STORE_RELEASED` in `web/lib/open-in-app.ts` is `false` until the app is on the App Store
(#451). Until then no page links to the App Store (its page says "not available") and the
open-in-app fallback stays on the page; the copy says the app is coming soon. On release day,
flip it to `true` in a PR; the merge redeploys the site. There is no Android listing, so no page
links to Google Play (#139).

## Bring-up (two applies)

ECS cannot create a service until its family has a registered revision, and the first revision
comes from the first CI run. So `web_enabled` (`infra/variables.tf`, default `false`) gates the
service, the listener rules, the DNS records and the uptime alarm:

1. **Apply 1** (`web_enabled = false`): from `infra/`, `terraform plan` then `terraform apply`
   creates the ECR repository and lifecycle policy, the log group, the security group and the
   target group. Nothing is routed to them.
2. **Merge** the PR that carries `web.tf`. `build-and-deploy-web` builds, pushes and, finding no
   service, registers the first revision only ("registering the revision only" in the job summary).
3. **Apply 2**: a PR that sets the `web_enabled` default to `true`; apply from that branch, then
   merge it. The apply creates the service, the listener rules, the apex and `www` records and the
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
