# Infrastructure — CapyHoops / bball-tracker

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
| `dns.tf` | Route53 hosted zone, ACM certificate |
| `ses.tf` | SES domain identity, DKIM/SPF, IAM policy for ECS task |
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

## Email — SES, DKIM, and SPF

Transactional email is sent from `noreply@mail.capyhoops.com` via AWS SES v2.

### How `ses.tf` works

1. **SES domain identity** is created for `mail.capyhoops.com` with Easy DKIM
   (RSA-2048).  SES generates three CNAME tokens.
2. **Three DKIM CNAME records** are added to the Route53 hosted zone so SES
   can sign outbound mail.  The records look like:
   ```
   <token>._domainkey.mail.capyhoops.com  CNAME  <token>.dkim.amazonses.com
   ```
3. **SPF TXT record** tells receiving servers that Amazon SES is authorised to
   send on behalf of `mail.capyhoops.com`:
   ```
   mail.capyhoops.com  TXT  "v=spf1 include:amazonses.com ~all"
   ```
4. **MX record** routes bounces and complaints back to the SES feedback
   endpoint (required for bounce/complaint handling; the region in the host
   below is derived from `var.aws_region` in `ses.tf`):
   ```
   mail.capyhoops.com  MX  10 feedback-smtp.us-east-1.amazonses.com
   ```
5. **IAM policy** (`ses_send`) grants the ECS task role `ses:SendEmail` /
   `ses:SendRawEmail` on the identity ARN only (least-privilege).

### DMARC (recommended follow-up)

Add a DMARC policy TXT record at `_dmarc.mail.capyhoops.com` once you have
confirmed DKIM and SPF are passing:

```
_dmarc.mail.capyhoops.com  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@capyhoops.com; pct=100"
```

Start with `p=none` (monitor mode) before moving to `p=quarantine`.

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
| `SES_FROM_ADDRESS` | ECS task definition env | `noreply@mail.capyhoops.com` |

Both variables are pre-filled in `env.example` (with a comment to leave them
blank in dev/test); leaving them blank causes the backend to fall back to the
in-memory `FakeMailer` (no real emails sent in dev/test).
