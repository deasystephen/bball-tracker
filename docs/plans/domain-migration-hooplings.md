# Domain migration: capyhoops.com → hooplings.com

**Date:** 2026-09-06 · **Status:** plan, eng-reviewed (`/plan-eng-review`, decisions D1–D25 below, incl. outside-voice tensions D19–D25) · **Owner:** Stephen Deasy

## Goal

Remove every `capyhoops` reference from the project so the code, infra, emails and docs all name the
product's real domain, **hooplings.com**, without taking the production API away from any TestFlight
device that has not yet taken the OTA.

## What this is (and is not)

An inventory (`git grep -i capyhoops`, 2026-09-06) found 163 lines in 42 files. ~150 of them are the
hostname `capyhoops.com`; the brand *name* survives only in three mailer templates and the calendar
feed's `uid`/`productId`. So this is a **domain migration with a small brand sweep**, not a rename.
The runtime is already ~90 % indirected through env (`PUBLIC_APP_URL`, `API_BASE_URL`,
`SES_FROM_ADDRESS`, `CORS_ORIGIN`, `WORKOS_REDIRECT_URI`, Expo `extra.apiUrl`); the work is config,
Terraform, and the places that hardcode a fallback.

Timing is favourable and gets worse every week: the apex has no A record, `web/` has never been
deployed (#30), there are no production users, no calendar subscribers, no App Store listing and no
WorkOS production keys (#24). Each of those, done first, would be one more surface to migrate.

## Decisions (from the eng review)

| # | Decision | Chosen |
|---|----------|--------|
| D3 | Sweep scope | **Full sweep, every file** — dated plan docs included |
| D4 | Terraform shape | **`for_each` over a `domain_names` set + `moved` blocks + `import` of the live hooplings zone**; `terraform plan` must show **0 destroys** |
| D5 | Web host for the apex | **Deferred.** API + mail migrate; the apex stays unserved; #30 stays open |
| D6 | Cutover | **Gated phases** with a written verification gate each, and a **dated retire PR** |
| D7 | iCal `uid`/`productId` | **Change now** to `@hooplings.com` / `hooplings/ical` (zero subscribers = only free window) |
| D8 | Other legacy ids (`bball-tracker://` scheme, EAS slug, repo name) | **Separate issues**, ride the next native build; bundle id never changes |
| D9 | DMARC | **Add `_dmarc.mail.<domain>` for each domain** (p=none, rua) inside the same rewrite — this delivers one bullet of **#449**; PR1 posts a status comment there, and the `dmarc@` receiving mailbox + later `p=quarantine` tightening are recorded on #449, not a new issue (D18) |
| D10 | Backend URL reads | **`utils/urls.ts`** `publicAppUrl()` / `apiBaseUrl()`; fallback `http://localhost:3000`; boot warning in production when unset |
| D11 | Mobile apiUrl reads | **`config/env.ts` becomes the single source**; api-client + socket import it |
| D12 | Mailer brand string | **`templates/brand.ts` `APP_NAME`** + a no-retired-name test |
| D13 | Test fixtures | **Brand-neutral** (`*.example.test`) in env-driven tests; `cors.test` stays bound to the deploy file |
| D14 | Deploy-file test | **`tests/infra/task-definition.test.ts`** over all five domain-bearing env values |
| D15 | Terraform in CI | **`fmt -check` + `validate` job**, no credentials; plan/apply stay manual |
| D16 | Expo config test | **`__tests__/app-config.test.ts`** pins `apiUrl` per `APP_ENV` and the `applinks:` entitlement |
| D17 | Orphan capyhoops registrar zone | **Deleted 2026-09-06** (`Z00525741R95GUOKQQZ38`, NS+SOA only, not delegated) |
| D18 | DMARC receiver / tightening | **On #449**, not a new issue |
| D19 | Outside voice vs D4 (additive PR1 + flip in PR4) | **D4 kept**: no destroy of a live cert/zone in any apply; the loop is the home for the other hooplings TLDs |
| D20 | Cert coverage | **Add the apex SAN** to every cert in the loop (`*.<d>` + `<d>`); the capyhoops cert re-issues create-before-destroy — one deliberate replace in Gate 1 |
| D21 | Custom MAIL FROM | **Add `aws_sesv2_email_identity_mail_from_attributes`** per domain so SPF aligns. Implementation note (PR1): SES requires the MAIL FROM to be a *subdomain* of the identity, so it is `bounce.mail.<domain>` and the MX/SPF records **move** there (the `mail.<domain>` MX/TXT are destroyed and recreated at the new name — two record destroys in the plan, expected) |
| D22 | capyhoops after retire | **Zone-only entry** (`serve = false`): cert, api record, SES identity and mail records go; the zone stays so the registrar delegation never goes lame |
| D23 | Transition CORS | **Drop capyhoops origins in PR2**; no `TRANSITION_HOSTS`; the deploy-file test is hooplings-only from day one |
| D24 | DMARC `rua` | **Omit `rua`** (`v=DMARC1; p=none`) until #449 builds the receiver |
| D25 | Six outside-voice checklist lines | **Accepted** into Gates 1–3 (two-step apply, `eas env:list`, tfvars, import comment diff, brand-guard scope, WorkOS check in Gate 2) |

## Live state that shaped the plan (verified 2026-09-06)

- `hooplings.com` (and `.app`, `.net`, `.org`) each already have a Route53 hosted zone created by
  Amazon Registrar at purchase, **with the registrar's NS delegation live**. `hooplings.com` =
  `Z0154069130H854Y9T0WZ`, 2 records (NS + SOA). A Terraform `resource` that *creates* a zone would
  make a second zone that nothing delegates to.
- `capyhoops.com` **had two** zones: `Z00525741R95GUOKQQZ38` ("HostedZone created by Route53
  Registrar", NS+SOA only, orphan) and `Z0921515V3ICX0S8DYA4` ("Managed by Terraform", 10 records, the
  one the registrar NS were hand-repointed to). That is the split the import avoids repeating. **The
  orphan was deleted during this review (2026-09-06, D17)** after confirming it held only NS+SOA and
  was not the delegated zone; Gate 1 can therefore assert exactly one zone for both domains.
- ACM: one cert, `api.capyhoops.com` + `*.capyhoops.com`, ISSUED. The ALB HTTPS listener holds it as
  `certificate_arn`; there is no `aws_lb_listener_certificate`.
- SES: account is **still in the sandbox** (`ProductionAccessEnabled: false`); `mail.capyhoops.com`
  is the only domain identity. Sandbox status is account-wide, so the new identity needs DKIM
  verification only, not a new production-access request.
- `.github/workflows/ci.yml` has no terraform job and no web job. `infra/**` (non-`.md`) changes
  trigger a full ECS image rebuild + rollout (`detect-changes` filter).
- Mobile sign-in passes its own `redirect_uri=bball-tracker://auth/callback`; `WORKOS_REDIRECT_URI`
  is the fallback used only by the web flow. Swapping it does not affect the app.

## What already exists (reused, not rebuilt)

| Sub-problem | Existing thing | Plan |
|---|---|---|
| Domain-parameterised infra | every DNS/ACM/SES resource reads `var.domain_name` | generalise to a set, keep addresses via `moved` |
| Cert on the ALB | `aws_lb_listener.https.certificate_arn` | keep as the **primary** cert; add `aws_lb_listener_certificate` for the others (SNI) |
| Env-driven URLs | `PUBLIC_APP_URL`, `API_BASE_URL`, `SES_FROM_ADDRESS`, `CORS_ORIGIN`, `WORKOS_REDIRECT_URI` in `infra/task-definition.json` | edit values; no code reads change except the fallbacks |
| API URL on device | `Constants.expoConfig.extra.apiUrl` from `app.config.js` at publish time | OTA carries the new host; no native build needed |
| Config-bound test pattern | `tests/api/cors.test.ts` reads `task-definition.json` | copy the reader into `tests/infra/task-definition.test.ts` |
| Brand guard | `mobile/__tests__/i18n/brand-guard.test.ts` with `ALLOWED_DOMAINS` | flip the allowlist so leftover `capyhoops.com` fails CI |
| Brand constant | `mobile/app/about.tsx#APP_NAME` | mirror in `backend/src/services/mailer/templates/brand.ts` |
| Base-URL helpers | `calendar-service.ts` already has `apiBaseUrl()`/`publicAppUrl()`-shaped functions | lift into `utils/urls.ts`, import from the three services |

## NOT in scope

| Deferred | Why |
|---|---|
| Serving `hooplings.com` (Next.js `web/`, AASA, assetlinks) | D5. Host undecided; #30 stays the tracker. `PUBLIC_APP_URL` keeps emitting links to an unserved apex, exactly as today. |
| `applinks:` Universal Links working end to end | Depends on the apex being served. The entitlement string flips in `app.config.js` and ships with whatever native build comes next; no build is cut for it. |
| Renaming `bball-tracker://`, the EAS slug, the GitHub repo | D8. Own issues; the scheme needs a native build + WorkOS URI + `ALLOWED_REDIRECT_SCHEMES` overlap. |
| Bundle id `com.bballtracker.mobile` | Changing it creates a new App Store app. Frozen. |
| WorkOS production keys, SES production access | #24 and the SES request are unchanged by the domain; they just target hooplings when they happen. |
| Redirecting `capyhoops.com` → `hooplings.com` | Nothing resolves at the apex today; there is nothing to redirect. The domain stays **registered** so nobody squats it. |
| Android App Links fingerprint | #139, lands on the new domain when the web deploy exists. |
| `hooplings.app/.io/.net/.org` | Registered defensively; no records until a marketing site wants redirects. |

## Architecture

### Transition topology

```
                         ┌──────────────── Route53 ────────────────┐
  registrar NS ───▶ zone capyhoops.com (TF, moved)   zone hooplings.com (TF, IMPORTED)
                     api A ──▶ ALB                    api A ──▶ ALB
                     mail.* MX/SPF/DKIM/_dmarc        mail.* MX/SPF/DKIM/_dmarc
                         └───────────┬─────────────────────┬─────┘
                                     ▼                     ▼
                              ┌─────────────── ALB :443 ───────────────┐
                              │ default cert: hooplings (primary)      │
                              │ + listener cert: capyhoops (SNI)       │
                              └─────────────────┬────────────────────┘
                                                ▼
                                       ECS task (one revision)
                                       env: PUBLIC_APP_URL=https://hooplings.com
                                            API_BASE_URL=https://api.hooplings.com
                                            SES_FROM_ADDRESS=noreply@mail.hooplings.com
                                            CORS_ORIGIN=hooplings api+apex+www (capyhoops origins dropped in PR2, D23)
                                            WORKOS_REDIRECT_URI=https://api.hooplings.com/api/v1/auth/callback

  builds #25–#30, pre-OTA ──▶ api.capyhoops.com ─┐
  builds #25–#30, post-OTA ─▶ api.hooplings.com ──┴─▶ same ALB, same task
```

Both hostnames hit the same task. Nothing about the transition is visible server-side except the
`Host` header; the API has no host-based logic.

### Terraform design (D4, D9)

```hcl
# D22: every registered domain keeps a zone; `serve` controls everything else (cert, api, mail)
variable "domains" { type = map(object({ serve = bool }))
  default = { "hooplings.com" = { serve = true }, "capyhoops.com" = { serve = true } } }   # PR4: capyhoops serve = false
variable "primary_domain" { type = string; default = "hooplings.com" }   # listener default cert, outputs
locals { served = { for d, c in var.domains : d => c if c.serve } }

resource "aws_route53_zone" "main"   { for_each = var.domains; name = each.key }
resource "aws_acm_certificate" "main" { for_each = local.served
  domain_name = "api.${each.key}"; subject_alternative_names = ["*.${each.key}", each.key]; … }   # D20: apex SAN
resource "aws_route53_record" "api"   { for_each = local.served; zone_id = aws_route53_zone.main[each.key].zone_id; … }
resource "aws_sesv2_email_identity" "mail" { for_each = local.served; email_identity = "mail.${each.key}" }
resource "aws_sesv2_email_identity_mail_from_attributes" "mail" { for_each = local.served   # D21
  email_identity = aws_sesv2_email_identity.mail[each.key].email_identity
  mail_from_domain = "mail.${each.key}"; behavior_on_mx_failure = "USE_DEFAULT_VALUE" }
# DKIM is domain × 3 tokens — flatten into an explicit map, never nest count inside for_each:
locals { dkim = { for pair in setproduct(keys(local.served), [0, 1, 2]) :
  "${pair[0]}-${pair[1]}" => { domain = pair[0], idx = pair[1] } } }
resource "aws_route53_record" "ses_dkim"  { for_each = local.dkim; … }
resource "aws_route53_record" "ses_mx"    { for_each = local.served; … }
resource "aws_route53_record" "ses_spf"   { for_each = local.served; … }
resource "aws_route53_record" "ses_dmarc" { for_each = local.served                       # D24: no rua until #449
  name = "_dmarc.mail.${each.key}"; type = "TXT"; records = ["v=DMARC1; p=none"] }

# Listener: primary cert stays on the listener; the rest attach via SNI
resource "aws_lb_listener" "https" { certificate_arn = aws_acm_certificate_validation.main[var.primary_domain].certificate_arn … }
resource "aws_lb_listener_certificate" "extra" {
  for_each = { for d, c in local.served : d => c if d != var.primary_domain }
  listener_arn = aws_lb_listener.https.arn; certificate_arn = aws_acm_certificate_validation.main[each.key].certificate_arn }

# IAM: FromAddress condition covers every mail domain
values = [for d in keys(local.served) : "*@mail.${d}"]

# Keep the capyhoops resources at their new addresses — the plan MUST show 0 destroy for these
moved { from = aws_route53_zone.main            to = aws_route53_zone.main["capyhoops.com"] }
moved { from = aws_acm_certificate.main         to = aws_acm_certificate.main["capyhoops.com"] }
moved { from = aws_acm_certificate_validation.main to = aws_acm_certificate_validation.main["capyhoops.com"] }
moved { from = aws_route53_record.api           to = aws_route53_record.api["capyhoops.com"] }
moved { from = aws_sesv2_email_identity.mail    to = aws_sesv2_email_identity.mail["capyhoops.com"] }
moved { from = aws_route53_record.ses_mx        to = aws_route53_record.ses_mx["capyhoops.com"] }
moved { from = aws_route53_record.ses_spf       to = aws_route53_record.ses_spf["capyhoops.com"] }
moved { from = aws_route53_record.ses_dkim[0]   to = aws_route53_record.ses_dkim["capyhoops.com-0"] }  # ×3

# Adopt the registrar-created zone instead of creating a twin
import { to = aws_route53_zone.main["hooplings.com"]; id = "Z0154069130H854Y9T0WZ" }
```

Notes for the implementer:

- **D20 side effect:** adding the apex SAN changes the capyhoops certificate too, so Gate 1's plan shows **one deliberate replace** of `aws_acm_certificate.main["capyhoops.com"]`; `create_before_destroy` is already set, so the old cert stays on the listener until the new one is ISSUED. Any *other* replace/destroy on a cert or zone aborts the apply.
- **Expect a two-step apply (D25/#4):** `cert_validation`'s `for_each` derives its keys from `domain_validation_options` of a certificate that does not exist yet; if `terraform plan` reports "Invalid for_each argument … cannot be determined until apply", run `terraform apply -target='aws_acm_certificate.main["hooplings.com"]'` first, then the full plan/apply.
- **`infra/terraform.tfvars` (gitignored) sets `domain_name = "capyhoops.com"` on line 14 (D25/#7).** Move it to the new `domains` map before Gate 1 or Terraform warns about an undeclared variable and the old value silently vanishes.
- **The import shows an in-place diff on the zone comment (D25/#8):** the registrar zone says "HostedZone created by Route53 Registrar", Terraform's default is "Managed by Terraform". Expected, not a mis-import. Delete the `import` block from the code after the apply (it is a one-shot instruction).
- `aws_route53_record.cert_validation` keys change shape (`domain|dvo.domain_name`). If a `moved`
  cannot express it, a destroy/recreate of a **validation CNAME** is acceptable: `allow_overwrite =
  true` is already set and only ACM reads the record. The zone, the certificate, the API record and
  the SES identity are the four resource types where **any** destroy in the plan aborts the apply.
- The **listener cert swap is one atomic attribute change**: the listener's default flips from the
  capyhoops cert to the hooplings cert while the capyhoops cert re-attaches via
  `aws_lb_listener_certificate` in the same apply. Both certs are valid for their hosts; SNI picks
  per request. Verify with `openssl s_client -servername api.capyhoops.com` **and**
  `-servername api.hooplings.com` after apply.
- The `certificate_arn` on the listener references `aws_acm_certificate_validation`, so the
  hooplings cert must be ISSUED before the listener change applies. Terraform orders this itself;
  the DNS validation for a zone whose NS are already live takes minutes.
- `outputs.tf`: `api_url` / `certificate_arn` from `var.primary_domain`; `name_servers` becomes a map
  keyed by domain.
- `infra/README.md` and `docs/deployment/aws-setup.md` currently instruct "update your registrar's
  NS with `terraform output name_servers`". That is the step that produced the orphan zone. Rewrite
  to: zones for Route53-registered domains are **imported**; the registrar already delegates to them.

### Backend (D7, D10, D12)

- `backend/src/utils/urls.ts`: `publicAppUrl()`, `apiBaseUrl()` (trailing slash stripped, fallback
  `http://localhost:3000`) and `warnMissingUrlConfig(env, logger)` called once from `index.ts` at boot
  (warns in `NODE_ENV=production` when either var is unset). `invitation-service.ts:421`,
  `guardian-service.ts:338`, `calendar-service.ts:23,30` import the helpers.
- `calendar-service.ts:234` `uid: game-${id}@hooplings.com`; `:249` `productId: 'hooplings/ical'`.
- `mailer/templates/brand.ts` exports `APP_NAME = 'Hooplings'`; the four templates interpolate it in
  every footer and body line (the six "CapyHoops app" lines included).
- `infra/task-definition.json`: five values as in the topology diagram. `CORS_ORIGIN` becomes
  `https://api.hooplings.com,https://hooplings.com,https://www.hooplings.com` **in PR2** (D23): no
  browser has ever sent a capyhoops `Origin` because nothing has ever served that host, so there is
  no transition list to carry. Asymmetric with the API hostname on purpose: `api.capyhoops.com` stays
  served for old binaries, which send no `Origin` at all.
- `backend/env.example`, `rate-limit.ts:76` comment, `calendar-service.ts:19` comment.

### Mobile (D11, D16)

- `config/env.ts` exports `getApiUrl()` = `extra.apiUrl || (__DEV__ ? 'http://127.0.0.1:3000' :
  'https://api.hooplings.com')` (the live `127.0.0.1` form, not the dead file's `localhost`);
  `services/api-client.ts:12` and `services/socket.ts:31` import it.
- `app.config.js:5-6` fallbacks → `https://api.hooplings.com`; `:44-49` comment + `associatedDomains:
  ['applinks:hooplings.com']` (inert until #30, harmless, ships with the next native build).
- `app/invite/[token].tsx:3` comment.
- `__tests__/i18n/brand-guard.test.ts:38` `ALLOWED_DOMAINS = ['hooplings.com']` — from then on any
  `capyhoops.com` left in mobile source, locales or `.maestro/` fails CI (the retired-brand regex
  `/capy[\s_-]*hoops/i` already matches the hostname once it is no longer stripped).

### Docs sweep (D3: every file)

`CLAUDE.md` (10), `README.md` (2), `ROADMAP.md` (1), `docs/deployment/aws-setup.md` (5),
`docs/development/release-strategy.md` (3), `docs/features/practice-schedules-plan.md` (1),
`docs/plans/parent-role-spec.md` (1), `docs/plans/self-serve-team-creation-and-league-scoping.md` (1),
`docs/plans/team-lineage-and-competition.md` (2), `docs/runbooks/rds-backup-restore.md` (2),
`docs/testing/e2e-test-plan-v2.0.md` (24), `infra/README.md` (10, incl. deleting the DMARC
follow-up section), `web/README.md` (5), `infra/dns.tf`/`ses.tf` header comments,
`infra/terraform.tfvars.example`, `infra/variables.tf` description. Also `CLAUDE.md`'s brand-guard
paragraph ("When the domain moves to hooplings.*, delete that entry…") becomes past tense.

## Phases, PRs and gates (D6)

Apply-before-merge rule from `CLAUDE.md` applies to PR1: **`terraform apply` first, then merge**, and
expect the merge to roll a no-op ECS revision.

### PR1 — infra (`infra/**`, `.github/workflows/ci.yml`, infra docs)

Terraform rewrite per the design above + DMARC + the `terraform fmt -check`/`validate` CI job +
`infra/README.md` / `aws-setup.md` rewrite.

**Before apply:** move `infra/terraform.tfvars` from `domain_name` to the `domains` map (D25/#7).

**Gate 1 (all must pass before PR2 merges):**

```
terraform plan          # import shown for the hooplings zone; ONE replace (capyhoops cert, apex SAN, create-before-destroy); zero other destroys on zone / certificate / api record / SES identity; in-place comment change on the imported zone is expected
terraform apply         # may need -target='aws_acm_certificate.main["hooplings.com"]' first (D25/#4)
# then delete the import block from dns.tf
curl -sSI https://api.hooplings.com/health                                     # 200, cert valid
openssl s_client -connect api.capyhoops.com:443 -servername api.capyhoops.com  # still serves the capyhoops cert (SNI)
aws sesv2 get-email-identity --email-identity mail.hooplings.com --query VerifiedForSendingStatus   # true
aws sesv2 get-email-identity --email-identity mail.hooplings.com --query MailFromAttributes.MailFromDomainStatus   # SUCCESS (D21)
dig +short TXT _dmarc.mail.hooplings.com                                       # v=DMARC1 …
aws route53 list-hosted-zones --query "HostedZones[?ends_with(Name,'hooplings.com.') || ends_with(Name,'capyhoops.com.')]"   # exactly ONE zone per domain
```

### PR2 — backend + deploy file (`backend/**`, `infra/task-definition.json`)

`utils/urls.ts` + boot warning, calendar ids, `brand.ts`, env values, tests (neutral fixtures,
`task-definition.test.ts`, `cors.test` flip, `urls.test.ts`, calendar uid test, mailer brand
test), `env.example`, backend/root docs. CI deploys it.

**Before merge (D25/#11):** add `https://api.hooplings.com/api/v1/auth/callback` as a redirect URI in
the WorkOS dashboard (staging environment); keep the old one until PR4. This is the PR whose deploy
starts using the value.

**Gate 2:**

```
curl -sS https://api.hooplings.com/health && curl -sS https://api.capyhoops.com/health   # both db ok, same task revision
curl -sSI -X OPTIONS https://api.hooplings.com/api/v1/invitations/by-token/x/accept -H 'Origin: https://hooplings.com' -H 'Access-Control-Request-Method: POST'   # 204 + ACAO
# WorkOS dashboard lists the new redirect URI (D25/#11)
# send one invite to a sandbox-verified address; headers show From: noreply@mail.hooplings.com, Return-Path @mail.hooplings.com (custom MAIL FROM, D21), DKIM=PASS, SPF=PASS **aligned**, dmarc=pass, body says "Hooplings app"
aws logs tail /ecs/bball-tracker-production --since 5m | grep -i 'PUBLIC_APP_URL\|API_BASE_URL'   # no "unset" warning
```

### PR3 — mobile (`mobile/**`) + production OTA in the same session

`config/env.ts` single source, `app.config.js`, brand-guard flip, `app-config.test.ts`,
`config/env.test.ts`, mobile docs (the sentry test fixtures are swept by D13, not by the guard —
brand-guard skips `__tests__/`; the `onboarding-role.test.tsx` mention is a deliberate negative
assertion and stays). **Pre-publish:** `eas env:list --environment production` must show no
`API_URL` (D25/#5; verified absent 2026-09-06). Then `eas update --environment production` (verify the
CLI line lists `APP_ENV`), and verify the manifest's `extra.apiUrl` is `https://api.hooplings.com`.

**Gate 3:** every TestFlight device relaunched twice; About screen shows the new update id; Games
tab loads; live game socket connects (`api.hooplings.com` in Sentry breadcrumbs if any). Record the
date on the parent issue.

### PR4 — retire (dated; only after Gate 3)

Flip `capyhoops.com` to `serve = false` in `domains` (apply → destroys the capyhoops cert, API record,
SES identity, MAIL FROM and mail records — **intended**; the **zone stays** so the registrar's NS
delegation never goes lame, D22; the domain stays registered), and delete the old WorkOS redirect
URI. CORS and the tests already moved in PR2 (D23), so this PR is Terraform + WorkOS only.

(The orphan registrar zone `Z00525741R95GUOKQQZ38` was already deleted on 2026-09-06, see D17.)

## Tests (Section 3)

Regression (CRITICAL, unconditional): `tests/utils/urls.test.ts` (set / unset / trailing slash /
production-warning branches) and the `cors.test.ts` apex flip. Then:

| Test | Kind | Asserts |
|---|---|---|
| `backend/tests/utils/urls.test.ts` | unit | helpers + `warnMissingUrlConfig` warns only when production AND unset |
| `backend/tests/infra/task-definition.test.ts` | config-bound | 5 env values on hooplings hosts; no capyhoops anywhere (no transition constant, D23) |
| `backend/tests/api/cors.test.ts` | config-bound | apex `https://hooplings.com` preflight 204 + ACAO; foreign origin no ACAO; no capyhoops assertion |
| `backend/tests/services/calendar-service.test.ts` | unit | `uid` matches `/^game-.+@hooplings\.com$/`; `productId === 'hooplings/ical'` |
| `backend/tests/services/mailer.test.ts` | unit | every rendered template contains `APP_NAME`, none matches `/capy[\s_-]*hoops/i` or `/basketball[\s_-]*tracker/i`; existing asserts on neutral fixture URLs |
| invitation / guardian / calendar service+api tests | unit | unchanged behaviour with `https://app.example.test` / `https://api.example.test` |
| `mobile/__tests__/config/env.test.ts` | unit | `extra.apiUrl` wins; `__DEV__` → `127.0.0.1`; production → `api.hooplings.com` |
| `mobile/__tests__/app-config.test.ts` | unit | `APP_ENV=production|preview` → `extra.apiUrl === 'https://api.hooplings.com'`, `ios.associatedDomains` includes `applinks:hooplings.com`; unset → `127.0.0.1`; `API_URL` override wins |
| `mobile/__tests__/i18n/brand-guard.test.ts` | existing | allowlist flipped; self-test derives from the array |
| `.github/workflows/ci.yml` terraform job | CI | `fmt -check -recursive`, `init -backend=false`, `validate` on `infra/**` |
| Maestro | none | no user-visible behaviour changes; OTA verification is Gate 3 |

## Failure modes

| Codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| Terraform apply | apex SAN re-issues the capyhoops cert destroy-first | Gate 1 plan read (must be create-before-destroy) | `lifecycle { create_before_destroy }` already set | api.capyhoops.com TLS error for old builds if wrong |
| Terraform apply | `terraform.tfvars` still declares `domain_name` | D25/#7 pre-apply step | warning only; value silently unused | nothing, but the map default decides |
| SES MAIL FROM | MX lookup fails at send time | Gate 1 `MailFromDomainStatus` | `USE_DEFAULT_VALUE` falls back to amazonses.com | mail still sends, SPF unaligned |
| Terraform apply | a `moved` mis-addressed → plan shows destroy of the capyhoops cert | Gate 1 plan read | abort before apply | nothing (caught) |
| Terraform apply | import ID wrong → second hooplings zone created | Gate 1 zone count | manual | api.hooplings.com never resolves |
| Listener cert swap | hooplings cert not yet ISSUED at apply | TF dependency order | TF waits on validation | nothing |
| ACM validation | DNS validation CNAME lands in the wrong zone | Gate 1 curl | manual | 8 min → hours of no cert |
| SES identity | DKIM not verified before PR2 deploys | Gate 1 SES query | SES rejects send; `emails.player=false` surfaces to the coach (existing) | "email could not be sent" toast |
| PR2 deploy | env value typo | `task-definition.test.ts` | CI fails | nothing |
| PR2 deploy | env var missing | boot warning + `urls.test.ts` | link falls back to localhost (obviously broken, not plausibly wrong) | localhost link in an email |
| OTA publish | `APP_ENV` unset on the publishing machine | `app-config.test.ts` pins the mapping; Gate 3 manifest check | manual | "Network error" on every tab (**the known footgun**) |
| Old build, pre-OTA | capyhoops hostname removed too early | Gate 3 → PR4 ordering | none in code | "Network error" on every tab |
| WorkOS | new redirect URI not registered before PR2 | Gate 1 checklist | WorkOS 400 on web sign-in only; mobile unaffected | web login error (no web today) |
| Calendar uid | changed after a subscriber exists | D7 timing (zero subscribers) | n/a | duplicate events (avoided) |

No critical gap: every silent failure has a gate or a test in front of it.

## Worktree parallelization

| Step | Modules | Depends on |
|---|---|---|
| PR1 infra | `infra/`, `.github/workflows/` | — |
| PR2 backend | `backend/`, `infra/task-definition.json`, root docs | Gate 1 for **merge**; code can be written in parallel |
| PR3 mobile | `mobile/` | Gate 2 for **OTA publish**; code can be written in parallel |
| PR4 retire | `infra/`, `backend/tests/`, `infra/task-definition.json` | Gate 3 (dated) |

Lane A: PR1 → (gate) → PR4. Lane B: PR2 code (independent). Lane C: PR3 code (independent).
Launch A, B, C in parallel worktrees; **merge** in order PR1 → PR2 → PR3; PR4 waits for Gate 3.
Conflict flag: PR1 and PR2 both touch `infra/` (`.tf` vs `task-definition.json`) — different files,
no textual conflict, but keep the deploy-file edit in PR2 so a single ECS rollout carries the env swap.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1 day / CC: ~50 min + apply)** — infra — Rewrite `dns.tf`/`ses.tf`/`ecs.tf`/`outputs.tf`/`variables.tf` to the `domains` map (`serve` flag) for_each + `moved` + `import`; apex SAN on every cert; `aws_sesv2_email_identity_mail_from_attributes` per domain; `aws_lb_listener_certificate`; IAM FromAddress list; update gitignored `terraform.tfvars`. Surfaced by: Architecture D4, D20, D21, D22, D25. Files: `infra/*.tf`, `infra/terraform.tfvars`. Verify: `terraform plan` shows import + one create-before-destroy replace (capyhoops cert) + 0 other destroys on zone/cert/api/SES.
- [ ] **T2 (P1, human: ~30 min / CC: ~5 min)** — infra — `ses_dmarc` record per domain (`v=DMARC1; p=none`, no `rua`); delete README DMARC follow-up; status comment on #449 (one deliverable met; `rua` + receiver + tightening stay there). Surfaced by: Architecture D9, D18, D24. Files: `infra/ses.tf`, `infra/README.md`. Verify: `dig TXT _dmarc.mail.hooplings.com`.
- [ ] **T3 (P1, human: ~30 min / CC: ~5 min)** — CI — terraform `fmt -check` + `init -backend=false` + `validate` job on `infra/**`. Surfaced by: Tests D15. Files: `.github/workflows/ci.yml`. Verify: job green on PR1.
- [ ] **T4 (P1, human: ~1 hr / CC: ~8 min)** — backend — `utils/urls.ts` + `warnMissingUrlConfig` at boot; three services import. Surfaced by: Code quality D10. Files: `backend/src/utils/urls.ts`, `index.ts`, `invitation-service.ts`, `guardian-service.ts`, `calendar-service.ts`, `tests/utils/urls.test.ts`. Verify: `npm test -- urls`.
- [ ] **T5 (P1, human: ~20 min / CC: ~3 min)** — backend — calendar `uid`/`productId` + test. Surfaced by: Architecture D7. Files: `calendar-service.ts`, `tests/services/calendar-service.test.ts`.
- [ ] **T6 (P1, human: ~40 min / CC: ~5 min)** — backend — `templates/brand.ts` `APP_NAME`, four templates, no-retired-name test. Surfaced by: Code quality D12. Files: `mailer/templates/*.ts`, `tests/services/mailer.test.ts`.
- [ ] **T7 (P1, human: ~30 min / CC: ~5 min)** — deploy — five env values in `task-definition.json`; `CORS_ORIGIN` = hooplings api+apex+www only. Surfaced by: Architecture D6, D23. Verify: `task-definition.test.ts`, `cors.test.ts`.
- [ ] **T8 (P1, human: ~45 min / CC: ~6 min)** — backend tests — `tests/infra/task-definition.test.ts`, hooplings-only, no transition constant. Surfaced by: Tests D14, D23.
- [ ] **T9 (P2, human: ~1 hr / CC: ~8 min)** — backend tests — neutral `*.example.test` fixtures in env-driven tests (incl. mobile sentry/redact fixtures); `cors.test` asserts the hooplings apex only. Surfaced by: Code quality D13, D23, D25.
- [ ] **T10 (P1, human: ~45 min / CC: ~6 min)** — mobile — `config/env.ts#getApiUrl()` single source; api-client + socket import; `__tests__/config/env.test.ts`. Surfaced by: Code quality D11.
- [ ] **T11 (P1, human: ~30 min / CC: ~4 min)** — mobile — `app.config.js` fallbacks + `applinks:hooplings.com` + comments; `__tests__/app-config.test.ts`. Surfaced by: Tests D16.
- [ ] **T12 (P1, human: ~10 min / CC: ~1 min)** — mobile — brand-guard `ALLOWED_DOMAINS = ['hooplings.com']`; fix whatever it then flags. Surfaced by: Step 0 completeness.
- [ ] **T13 (P2, human: ~2 hrs / CC: ~15 min)** — docs — full sweep of the 15 markdown files + `.tf` header comments + `env.example`; rewrite the registrar-NS instructions to the import flow. Surfaced by: Step 0 / D3.
- [ ] **T14 (P1, human: ~15 min / CC: ~5 min)** — mobile — `eas env:list --environment production` shows no `API_URL`; production OTA in the PR3 session; verify manifest `apiUrl`. Surfaced by: Architecture D6 (Gate 3), D25.
- [ ] **T15 (P2, dated, human: ~30 min / CC: ~5 min + apply)** — retire — flip capyhoops to `serve = false` (zone stays), delete the old WorkOS redirect URI. Surfaced by: Architecture D6, D22, D23.
- [ ] **T16 (P2, human: ~20 min / CC: ~10 min)** — issues — parent issue + PR1–PR4 children with the gates above; separate issues for scheme rename (+ `ALLOWED_REDIRECT_SCHEMES` overlap) and slug/repo rename. Surfaced by: D8, work-hygiene rule.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (2026-08-30, different plan: self-serve team creation) | STALE for this plan | 5 proposals, 2 accepted, 6 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 in 7 days (this plan: 2026-09-06 23:59) | CLEAR (PLAN) | 23 issues (6 arch, 4 code quality, 13 test gaps, 0 perf), 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **Outside voice:** Claude subagent (Codex not installed; same model family, fresh context). 12 points: 1 argued against settled D4 and was **rejected** (D19); 5 **accepted** as design changes (D20 apex SAN, D21 SES custom MAIL FROM, D22 zone-only retire, D23 drop transition CORS, D24 no `rua`); 6 accepted as checklist lines (D25). Logged as `codex-plan-review` source `claude`, `issues_found`.
- **CROSS-MODEL:** review and outside voice agreed on the migration being config-shaped, on importing the registrar zone, and on the OTA-only mobile path; disagreed on Terraform shape (review's for_each kept) and on the CORS/DMARC/cert details (outside voice's positions adopted).
- **Completion summary:** Step 0 scope accepted as **full sweep** (user chose the wider option over the recommended current-state sweep) · Architecture 6 issues · Code quality 4 issues · Test review: diagram produced, 13 gaps (5 accepted via D7/D10/D11/D12, 4 ops gates via D6, 3 decided D14–D16, 1 no-Maestro) · Performance 0 · NOT in scope written · What already exists written · TODOs: 2 proposed (orphan zone **done**, DMARC follow-up → existing #449) · Failure modes: 0 critical gaps · Outside voice: ran (claude) · Parallelization: 3 lanes (A infra→retire, B backend, C mobile), B+C parallel, merges sequential · Lake Score: 22/23 decisions took the complete option (D5 web deferral is the exception).
- **VERDICT:** ENG CLEARED — ready to implement (PR1 first; apply before merge). CEO review on file predates this plan and does not cover it; optional, not required.

NO UNRESOLVED DECISIONS
