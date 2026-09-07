# Infrastructure — Hooplings / bball-tracker

Terraform manages all AWS infrastructure.  
**Never run `terraform apply` without reviewing the plan output first.**

## Files

| File | Purpose |
|------|---------|
| `main.tf` | Provider config, locals, backend |
| `ecs.tf` | Fargate cluster, service, IAM roles, ALB, auto-scaling (**not** the task definition) |
| `rds.tf` | PostgreSQL RDS instance |
| `elasticache.tf` | Redis ElastiCache |
| `s3.tf` | S3 buckets (profile picture avatars) |
| `dns.tf` | Route53 hosted zones (one per registered domain), ACM certificates + validation, `api.` records |
| `ses.tf` | SES domain identities, DKIM, custom MAIL FROM (MX/SPF), DMARC, IAM policy for ECS task |
| `datadog.tf` | Datadog integration (log forwarder, metrics) |
| `variables.tf` | Input variable declarations |
| `outputs.tf` | Output values (ALB DNS, RDS endpoint, etc.) |
| `task-definition.json` | **The** ECS task definition - owned by CI, not Terraform (see below) |

---

## Who owns the ECS task definition

`infra/task-definition.json` is the single source of truth, and CI deploys it. The "Build & Deploy
to ECS" job (`.github/workflows/ci.yml`) renders it with the freshly built image tag, registers a
new revision and updates the service. Terraform manages the cluster, service, IAM roles, log group,
ALB and auto-scaling, but registers **no** task definition of its own (#53).

So:

- **To change an env var, a secret reference, or task cpu/memory** - edit `task-definition.json` and
  merge to main. Putting it in `ecs.tf` instead deploys nothing, silently.
- **New Secrets Manager ARNs** to reference from the JSON come from `terraform output`.
- `aws_ecs_service.app` is configured with the bare family name and carries
  `ignore_changes = [task_definition]`, so `terraform apply` never disturbs the revision CI chose.
- **Bootstrapping a fresh environment:** at least one revision of the family must exist before the
  service can be created. Register `task-definition.json` once with
  `aws ecs register-task-definition --cli-input-json file://task-definition.json` (after filling in
  the account-specific ARNs), then `terraform apply`.

**The tradeoff:** values Terraform used to interpolate (the Redis endpoint, the avatars bucket,
Secrets Manager ARNs, the IAM role ARNs) are now literal strings in the JSON. If one of those
resources is ever replaced, the JSON does not follow automatically — re-read it from Terraform and
update the file:

```bash
terraform output redis_url s3_avatars_bucket_name sentry_dsn_secret_arn
```

That is the accepted cost of having one source of truth; a stale literal fails loudly at task
start, whereas the previous split silently deployed neither copy.

---

## DNS — zones, certificates, domains

`var.domains` (variables.tf) is the list of registered domains, each with a `serve` flag:

```hcl
domains = {
  "hooplings.com" = { serve = true }
  "capyhoops.com" = { serve = false }  # retired 2026-09-07 (#503): zone only
}
primary_domain = "hooplings.com"
```

- **Every key gets a Route53 hosted zone.** `serve = true` additionally provisions an ACM
  certificate for `api.<domain>`, `*.<domain>` **and the bare apex** (the wildcard does not
  match the apex; a future web deploy on AWS needs no cert change), its DNS validation records,
  the `api.<domain>` alias to the ALB, and the SES identity + mail records below.
- **The primary domain's certificate is the HTTPS listener default**; every other served
  domain's certificate attaches via `aws_lb_listener_certificate` and is selected by SNI, so
  `api.<old-domain>` keeps answering for app binaries that have not taken the OTA yet.
- **Domains bought through Route53 Domains already have a hosted zone**, created by Amazon
  Registrar at purchase with live NS delegation. **Import it** (`import { to =
  aws_route53_zone.main["<domain>"] id = "<zone id>" }`, then delete the block after the apply)
  — never let Terraform create a second zone for such a domain. capyhoops.com had exactly that
  twin-zone split until 2026-09-06: Terraform created a zone, the registrar was hand-repointed
  to it, and the registrar-created zone sat orphaned. `terraform output name_servers` lists the
  delegation per zone; only a domain registered *elsewhere* needs its registrar pointed at them.
- **Retiring a domain = `serve = false`**, not removing the key. The certificate, API record,
  SES identity and mail records are destroyed; the zone stays so the registrar's NS delegation
  never points at a deleted zone (the orphan-zone shape again). The domain stays registered.
- **Reading a plan for a domain change:** an in-place tag/comment update on zones is expected;
  a certificate replace must show as `+/-` (create-before-destroy); the `cert_validation`
  records and the `aws_acm_certificate_validation` waiter may replace (their values come from
  the new certificate — ACM's validation CNAMEs are stable per account, so the records come
  back identical). **Any destroy of a zone, `api` record or SES identity that you did not
  intend is a stop.**

---

## Email — SES, DKIM, MAIL FROM, and DMARC

Transactional email is sent from `noreply@mail.<primary_domain>` via AWS SES v2. `ses.tf`
provisions the same set for every served domain:

1. **SES domain identity** `mail.<domain>` with Easy DKIM (RSA-2048). SES generates three
   CNAME tokens; the **three DKIM CNAME records** go into that domain's hosted zone:
   ```
   <token>._domainkey.mail.<domain>  CNAME  <token>.dkim.amazonses.com
   ```
2. **Custom MAIL FROM domain** `bounce.mail.<domain>`
   (`aws_sesv2_email_identity_mail_from_attributes`). SES requires the MAIL FROM to be a
   *subdomain* of the identity. Without it SES uses an `amazonses.com` envelope sender, SPF
   passes for Amazon's domain and is DMARC-unaligned, and the MX/SPF records are inert — that
   was the pre-2026-09 configuration. `behavior_on_mx_failure = USE_DEFAULT_VALUE` falls back
   to the SES default rather than failing sends if the MX ever disappears.
3. **MX + SPF at the MAIL FROM domain** (both required for MAIL FROM verification):
   ```
   bounce.mail.<domain>  MX   10 feedback-smtp.<region>.amazonses.com
   bounce.mail.<domain>  TXT  "v=spf1 include:amazonses.com ~all"
   ```
4. **DMARC** for the sending subdomain, monitor mode:
   ```
   _dmarc.mail.<domain>  TXT  "v=DMARC1; p=none"
   ```
   No `rua` yet: no mailbox exists to receive aggregate reports, and an external address
   (Gmail) would need an authorization record the receiving domain will not publish. **#449**
   owns the report receiver, the `rua` tag and the later tightening to `p=quarantine`.
5. **IAM policy** (`ses_send`) grants the ECS task role `ses:SendEmail` / `ses:SendRawEmail`
   with a `ses:FromAddress` condition covering `*@mail.<domain>` for every served domain.

**After apply**, per identity: `VerifiedForSendingStatus` must be `true` and
`MailFromAttributes.MailFromDomainStatus` must be `SUCCESS`:
```bash
aws sesv2 get-email-identity --email-identity mail.hooplings.com \
  --query '[VerifiedForSendingStatus,MailFromAttributes.MailFromDomainStatus]'
```

### SES sandbox → production

New SES accounts are in *sandbox mode* — email can only be sent to verified
addresses.  To request production access:

1. Open the AWS SES console → **Account dashboard** → **Request production access**.
2. Provide use case details (transactional only, no marketing).
3. Confirm bounce/complaint handling via SNS topics (see SES console).

### Environment variables

| Variable | Where set | Value in production |
|----------|-----------|---------------------|
| `AWS_SES_REGION` | ECS task definition env | `us-east-1` |
| `SES_FROM_ADDRESS` | ECS task definition env | `noreply@mail.hooplings.com` |

Both variables are pre-filled in `env.example` (with a comment to leave them
blank in dev/test); leaving them blank causes the backend to fall back to the
in-memory `FakeMailer` (no real emails sent in dev/test).
