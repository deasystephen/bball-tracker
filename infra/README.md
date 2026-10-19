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
| `dns.tf` | Route53 hosted zones (one per registered domain), ACM certificates + validation, `api.` records, CAA records, DNSSEC (KMS key, key-signing keys, signing) (#758) |
| `ses.tf` | SES domain identities, DKIM, custom MAIL FROM (MX/SPF), DMARC, IAM policy for ECS task |
| `workspace.tf` | Google Workspace mail at the apex of the primary domain: MX, SPF + domain verification, DKIM, apex DMARC, and the `google_*` variables (#555) |
| `ses-events.tf` | SES account-level suppression list, configuration set, event destination, SNS topic → SQS queue + dead-letter queue, IAM policy for the API to read the queue (#449) |
| `datadog.tf` | Datadog integration (log forwarder, metrics) |
| `alerting.tf` | SNS alerts topic + email subscription, CloudWatch alarms (ALB, ECS, RDS, SES reputation, SES event queue), Route 53 uptime check, and the `alert_email` / `alarm_*` variables |
| `variables.tf` | Input variable declarations |
| `outputs.tf` | Output values (ALB DNS, RDS endpoint, the Secrets Manager and IAM ARNs the task definition carries, `dnssec_keys` for the DS publication step) |
| `task-definition.json` | **The** ECS task definition - owned by CI, not Terraform (see below) |
| `bootstrap/` | The remote-state S3 bucket and DynamoDB lock table that `main.tf`'s backend block names, as a separate configuration with **local** state (see "Remote state"). Has its own `.terraform.lock.hcl`, kept identical to the parent's (`backend/tests/infra/terraform-lock-parity.test.ts`); excluded from the deploy filter like the parent's |
| `.terraform.lock.hcl` | Provider lock (`hashicorp/aws`), **committed** since #786 with hashes for `darwin_arm64` and `linux_amd64`, so every apply uses the same provider and Dependabot can propose minor and patch bumps within the pinned major (6.x since PR #913). CI runs `fmt`/`init`/`validate` on it (so a bumped lock is installable and validated) but never `plan` or `apply`: review a bump with `terraform init` + `terraform plan` ("No changes.") before merging. A local `init` may add hashes for another platform; do not commit that from a review. Changing only this file does not deploy. Majors are a human migration: 5 → 6 was done in PR #913 (#866) with a "No changes." plan; open an issue for the next one |

---

## Who owns the ECS task definition

`infra/task-definition.json` is the single source of truth, and CI deploys it. The "Build & Deploy
to ECS" job (`.github/workflows/ci.yml`) renders it with the freshly built image tag, registers a
new revision and updates the service. Terraform manages the cluster, service, IAM roles, log group,
ALB and auto-scaling, but registers **no** task definition of its own (#53).

So:

- **To change an env var, a secret reference, or task cpu/memory** - edit `task-definition.json` and
  merge to main. Putting it in `ecs.tf` instead deploys nothing, silently.
- **New Secrets Manager ARNs** to reference from the JSON come from `terraform output -raw <name>`; the output names are the ones in the block below (one per secret and per IAM role in `infra/outputs.tf`).
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
# `terraform output` takes at most one name; read each literal on its own.
# The outputs exist in state only after the `terraform apply` that added them,
# so a missing name stops the loop instead of printing an empty value.
for name in redis_url s3_avatars_bucket_name \
            ecs_execution_role_arn ecs_task_role_arn \
            database_url_secret_arn workos_api_key_secret_arn \
            workos_client_id_secret_arn sentry_dsn_secret_arn; do
  value=$(terraform output -raw "$name") || exit 1
  printf '%s=%s\n' "$name" "$value"
done
```

That is the accepted cost of having one source of truth; a stale literal fails loudly at task
start, whereas the previous split silently deployed neither copy.

---

## Remote state

`main.tf` keeps state in S3 bucket `bball-tracker-terraform-state` (key `infra/terraform.tfstate`,
SSE enforced by the backend's `encrypt = true`) and locks through DynamoDB table `terraform-locks`.
Both were created by hand on 2026-02-07/08, before any Terraform existed, and are now declared in
`bootstrap/` and imported (#641). That configuration deliberately uses **local state**: the bucket
cannot hold the state that declares it. The local file is gitignored and holds nothing sensitive;
if it is lost, the `import` blocks in `bootstrap/main.tf` re-adopt both resources on the next apply.

**The state object is the most sensitive object in the account.** It holds the RDS master password,
the WorkOS API key, the Datadog API key and the Sentry DSN in plaintext (Terraform's `sensitive`
flag only redacts CLI output). Read access to that one object is possession of every production
credential, so the bucket is held to: versioning on, all four public-access-block flags on, default
SSE-S3 with the bucket key and SSE-C blocked, `BucketOwnerEnforced` ownership, a bucket policy that
denies any request with `aws:SecureTransport = false`, and `prevent_destroy` on the bucket and the
table (deletion protection on the table too). Nothing in `bootstrap/` may ever plan a destroy.

Re-check the live posture (what the bootstrap configuration enforces) with:

```bash
aws s3api get-bucket-versioning     --bucket bball-tracker-terraform-state   # Status: Enabled
aws s3api get-public-access-block   --bucket bball-tracker-terraform-state   # four × true
aws s3api get-bucket-encryption     --bucket bball-tracker-terraform-state   # AES256, BucketKeyEnabled
aws s3api get-bucket-policy         --bucket bball-tracker-terraform-state   # DenyInsecureTransport
cd infra/bootstrap && terraform plan                                         # No changes.
```

Terraform is pinned to 1.5.x (`ci.yml`), so S3-native locking (`use_lockfile`, Terraform ≥ 1.10)
is not an option yet and the lock table stays. CI runs `fmt -recursive`, `init -backend=false` and
`validate` on `bootstrap/` like the parent; `plan` and `apply` there are manual, from a developer
machine with production credentials, and rare (the configuration changes only when the bucket's
posture does). The RDS master password that sits in that state has its own rotation procedure in
`docs/runbooks/rds-backup-restore.md`, "Rotate the master password".

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
- **A destroy of a zone is refused at plan time**: `aws_route53_zone.main` carries
  `lifecycle { prevent_destroy = true }` (pinned by `backend/tests/infra/prevent-destroy.test.ts`),
  so `terraform destroy`, a `-replace` of a zone or a renamed `var.domains` key errors with
  "Instance cannot be destroyed" before AWS is touched. Retiring a domain is still `serve = false`.
  `prevent_destroy` cannot depend on `var.environment`, so tearing down a **staging** stack with
  `terraform destroy` means lifting the guard by hand (delete the `lifecycle` block locally for that
  run, never commit it). The avatars bucket and RDS are not guarded this way: AWS refuses to delete a
  non-empty bucket, and RDS has `deletion_protection` (the restore runbook renames and imports it).
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

### CAA and DNSSEC (#758)

**CAA.** Every zone in `var.domains` carries a CAA record at its apex allowing only Amazon's four CA
identities (`amazon.com`, `amazontrust.com`, `awstrust.com`, `amazonaws.com`, `issue` and
`issuewild`). There is no `iodef` entry: it would publish an inbox in public DNS, and the only
candidate is the alerts address, which stays out of committed files. ACM checks CAA on every
issuance and renewal, so this list is exactly what keeps `aws_acm_certificate.main` renewing;
`backend/tests/infra/dns-caa.test.ts` pins it. **Rule:** a certificate for any `hooplings.com` name
issued by another CA (a web host outside AWS for #30, for example `letsencrypt.org`) needs that CA
added to `aws_route53_record.caa` in the same PR as the deploy, or the host's issuance fails on CAA.
Check first: `dig +short CAA hooplings.com`.

**DNSSEC.** One KMS key (`aws_kms_key.dnssec`, ECC_NIST_P256, created through the `aws.us_east_1`
provider alias because Route 53 accepts DNSSEC keys from that region only), one key-signing key per
zone and signing enabled, all with `prevent_destroy` and none of the in-place disable arguments set
(`backend/tests/infra/prevent-destroy.test.ts` pins both). Terraform does **not** publish the DS
record at the registrar; that is the owner's step, and a signed zone without a DS at the parent is
an insecure delegation that resolvers treat exactly as unsigned. **State:** both zones have been
signed and their DS records published since 2026-10-19 (chain of trust validated at Cloudflare,
Google and Quad9). The procedure below is for the next zone, or a key roll. Per zone, after the
apply that enabled signing:

1. **Wait for the zone's longest TTL to expire before publishing the DS**: the apex NS record is
   172800 s, so 48 hours. This is AWS's guidance, so that no validating resolver holds a cached
   unsigned answer when the chain of trust appears. On 2026-10-19 the owner published 17 minutes
   after enabling signing, accepting that risk for a zone whose other records all have TTL
   ≤ 3600 s; nothing broke, but the wait stays the documented default. Confirm Route 53 is signing:
   `aws route53 get-dnssec --hosted-zone-id <zone id> --query Status.ServeSignature` → `SIGNING`.
2. **Publish the DS** at Route 53 Domains (both domains are registered there). The call wants the
   DNSKEY public key, not the DS digest; read all three attributes from
   `terraform output -json dnssec_keys` rather than typing them, so a future key with another
   algorithm cannot be published with the wrong number:
   ```bash
   cd infra
   DOMAIN=hooplings.com
   ATTRS=$(terraform output -json dnssec_keys \
     | jq -r --arg d "$DOMAIN" '.[$d] | "Algorithm=\(.algorithm),Flags=\(.flags),PublicKey=\(.public_key)"')
   aws route53domains associate-delegation-signer-to-domain --region us-east-1 \
     --domain-name "$DOMAIN" --signing-attributes "$ATTRS"
   # prints an OperationId; poll until SUCCESSFUL (usually seconds, allow minutes):
   aws route53domains get-operation-detail --region us-east-1 --operation-id <id>
   ```
3. **Verify** once the parent serves the DS (seconds to an hour). Run it off any VPN or network
   that intercepts port 53: an interceptor answers for `@1.1.1.1` without validating, so the `ad`
   flag is missing (or copied) and the result means nothing. The block works for every zone in
   `var.domains`, served or not, because it queries the apex:
   ```bash
   DOMAIN=hooplings.com
   dig @1.1.1.1 +short DS "$DOMAIN"                        # one DS line, algorithm 13
   dig @1.1.1.1 +dnssec +noall +answer SOA "$DOMAIN"       # the SOA is followed by an RRSIG line
   for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
     printf '%s ' "$r"; dig @$r +dnssec SOA "$DOMAIN" | grep -o 'flags: [a-z ]*ad;' || echo 'NO ad'
   done
   # "ad" (authenticated data) from each validating resolver is the proof of the chain of trust.
   # Apple's `delv` is built without crypto ("No trusted keys were loaded"); on Linux,
   # `delv @1.1.1.1 "$DOMAIN" SOA` reports "; fully validated".
   curl -sS https://api.hooplings.com/health        # served zones only: still 200
   aws acm describe-certificate --certificate-arn <arn> --query 'Certificate.RenewalEligibility'   # ELIGIBLE
   ```

**Never** disable signing, deactivate a key-signing key or disable/delete the KMS key while a DS is
published: validating resolvers answer SERVFAIL for the whole zone. Retiring DNSSEC runs in reverse:
`aws route53domains disassociate-delegation-signer-from-domain`, wait 48 hours, then lift the
`prevent_destroy` guards and remove the resources. Moving a zone to another DNS host also starts
with removing the DS.

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
4. **DMARC** for the sending subdomain:
   ```
   _dmarc.mail.<primary_domain>  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@<primary_domain>"
   _dmarc.mail.<other domain>    TXT  "v=DMARC1; p=none"
   ```
   The policy and the report address are locals in `workspace.tf`, shared with the apex
   record, so the two cannot differ. Only the primary domain's record names the report
   address: for any other domain it is an external address, and receivers send nothing to it
   without an authorization record. Before `google_site_verification` is set no record
   carries `rua`. Tightening to `p=quarantine` follows about 30 days of clean reports (#555,
   step 5): change `local.dmarc_policy`, nothing else.
5. **IAM policy** (`ses_send`) grants the ECS task role `ses:SendEmail` / `ses:SendRawEmail`
   with a `ses:FromAddress` condition covering `*@mail.<domain>` for every served domain, on
   every identity **and on the configuration set** — a send that names a configuration set is
   authorized against the set's ARN too.

### Mail at the apex: Google Workspace (#555)

People read mail at `<primary_domain>` through Google Workspace; the application sends from
`mail.<domain>` through SES. `workspace.tf` declares the apex side, for the primary domain only:

| Record | Value |
| --- | --- |
| `<primary_domain>` MX | `1 smtp.google.com` (`google_mx_records`) |
| `<primary_domain>` TXT | `v=spf1 include:_spf.google.com ~all` and the domain verification value, in one record set |
| `google._domainkey.<primary_domain>` TXT | the DKIM key, split into strings of at most 255 characters |
| `_dmarc.<primary_domain>` TXT | `v=DMARC1; p=none; rua=mailto:dmarc@<primary_domain>` |

- **The two sending paths stay on separate names.** Do not add SES to the apex SPF and do not
  add Google to the `mail.` subdomain. `backend/tests/infra/workspace-mail.test.ts` fails on
  either, and on a DMARC value written anywhere but the shared locals.
- **Everything is off until `google_site_verification` is set.** The records come in two
  applies, because Google generates the DKIM key only after Gmail has been active for 24 to 72
  hours: first the verification value (verification + SPF, MX, apex DMARC, and `rua` on
  `_dmarc.mail.`), then `google_dkim_public_key`. In the Google admin console, start DKIM
  authentication only after the record resolves.
- **Both values are committed** as the variable defaults in `workspace.tf`. They are published
  in DNS and are not secrets. Paste the DKIM value as one string: the admin console shows a
  long key in quoted pieces, and the quotes and line breaks between them are not part of it.
- **Another TXT at the apex** (a verification for another service, for example) is a new entry
  in the `records` list of `workspace_apex_txt`. Route 53 holds every TXT value of a name in
  one record set, so a second resource for the same name fails on apply.
- Which addresses exist and which accounts must never move to them:
  [`docs/runbooks/email-deliverability.md`](../docs/runbooks/email-deliverability.md).

### Bounces, complaints and suppression (#449)

`ses-events.tf` declares, once for the account (reputation and suppression are account-wide, not
per domain):

1. **Account-level suppression list** for `BOUNCE` and `COMPLAINT`. This is what stops mail to a
   dead address: SES accepts the send, does not deliver it, and does not count it toward the
   bounce rate.
2. **Configuration set** `<prefix>-transactional`, named by the API on every send
   (`SES_CONFIGURATION_SET`). A send without it publishes no events.
3. **Event destination** publishing `BOUNCE`, `COMPLAINT`, `DELIVERY` and `REJECT` to the SNS
   topic `<prefix>-ses-events`. This is a separate topic from the alerts topic on purpose: that
   one has a person subscribed by email.
4. **SQS queue** `<prefix>-ses-events` subscribed to the topic with raw message delivery, and a
   **dead-letter queue** `<prefix>-ses-events-dlq` behind it (5 receives, 14-day retention). Both
   use SQS-managed encryption; events carry recipient addresses.
5. **IAM policy** (`ses_events_consume`) lets the ECS task role receive and delete from the queue
   (`SES_EVENTS_QUEUE_URL`).

Four alarms in `alerting.tf` watch it: bounce rate, complaint rate, a stalled queue, and a
non-empty dead-letter queue. Procedures and the apply order are in
[`docs/runbooks/email-deliverability.md`](../docs/runbooks/email-deliverability.md).

**Apply before the task definition names the configuration set.** `SES_CONFIGURATION_SET` in
`task-definition.json` deployed ahead of the apply makes every send fail.

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
3. Describe bounce and complaint handling. The answers are written out in
   [`docs/runbooks/email-deliverability.md`](../docs/runbooks/email-deliverability.md#what-to-tell-aws),
   and each one is a resource in `ses-events.tf` or `alerting.tf`.

### Environment variables

| Variable | Where set | Value in production |
|----------|-----------|---------------------|
| `AWS_SES_REGION` | ECS task definition env | `us-east-1` |
| `SES_FROM_ADDRESS` | ECS task definition env | `noreply@mail.hooplings.com` |
| `SES_CONFIGURATION_SET` | ECS task definition env | `terraform output ses_configuration_set_name` |
| `SES_EVENTS_QUEUE_URL` | ECS task definition env | `terraform output ses_events_queue_url` |

The first two are pre-filled in `env.example` (with a comment to leave them
blank in dev/test); leaving them blank causes the backend to fall back to the
in-memory `FakeMailer` (no real emails sent in dev/test). The last two are
commented out there: unset, sends carry no configuration set and the event
consumer does not start.
