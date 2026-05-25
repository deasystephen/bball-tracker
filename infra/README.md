# Infrastructure — CapyHoops / bball-tracker

Terraform manages all AWS infrastructure.  
**Never run `terraform apply` without reviewing the plan output first.**

## Files

| File | Purpose |
|------|---------|
| `main.tf` | Provider config, locals, backend |
| `ecs.tf` | Fargate cluster, task definition, IAM roles, ALB, auto-scaling |
| `rds.tf` | PostgreSQL RDS instance |
| `elasticache.tf` | Redis ElastiCache |
| `s3.tf` | S3 buckets (profile picture avatars) |
| `dns.tf` | Route53 hosted zone, ACM certificate |
| `ses.tf` | SES domain identity, DKIM/SPF, IAM policy for ECS task |
| `datadog.tf` | Datadog integration (log forwarder, metrics) |
| `variables.tf` | Input variable declarations |
| `outputs.tf` | Output values (ALB DNS, RDS endpoint, etc.) |

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
   endpoint (required for bounce/complaint handling):
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

Both variables are left blank in `env.example` and in the test environment,
which causes the backend to fall back to the in-memory `FakeMailer`
(no real emails sent in dev/test).
