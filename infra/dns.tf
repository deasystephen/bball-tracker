# Hooplings - Route53 DNS + ACM Certificates
#
# One hosted zone per registered domain (`var.domains`), and for every domain
# that is *served* (`serve = true`): an ACM certificate for `api.<domain>`,
# `*.<domain>` and the bare apex, its DNS validation records, and the
# `api.<domain>` alias to the ALB. The primary domain's certificate is the
# HTTPS listener default; the others attach via SNI (`ecs.tf`).
#
# Domains bought through Route53 Domains (Amazon Registrar) get a hosted zone
# created automatically WITH live NS delegation. Such a zone must be IMPORTED,
# never re-created: a second zone gets different name servers and the registrar
# keeps pointing at the first. (capyhoops.com had exactly that twin-zone split
# until 2026-09-06.) See infra/README.md "DNS — zones, certificates, domains".
#
# Retiring a domain: flip `serve = false`. The certificate, API record and mail
# identity are destroyed; the zone stays so the registrar delegation never
# points at nothing.

locals {
  # Domains that carry the API, certificate and mail identity.
  served_domains = { for d, cfg in var.domains : d => cfg if cfg.serve }
}

# =============================================================================
# Route53 Hosted Zones — one per registered domain
# =============================================================================

resource "aws_route53_zone" "main" {
  for_each = var.domains

  name = each.key

  tags = {
    Name = "${local.name_prefix}-dns-${each.key}"
  }

  # Registrar-created zones carry live NS delegation; a destroy here is the
  # capyhoops.com twin-zone outage. `prevent_destroy` makes `terraform plan`
  # refuse any destroy or replace of a zone before AWS is touched. Retire a
  # domain with `serve = false`, never by removing its key (infra/README.md
  # "DNS — zones, certificates, domains"). Pinned by
  # backend/tests/infra/prevent-destroy.test.ts.
  lifecycle {
    prevent_destroy = true
  }
}

# hooplings.com (Z0154069130H854Y9T0WZ) was IMPORTED on 2026-09-07 — the zone
# Amazon Registrar created at purchase, NS delegation already live. Adopt any
# future Route53-registered domain the same way (one-shot `import` block,
# deleted after the apply) rather than letting Terraform create a twin zone.

# =============================================================================
# ACM Certificates — api.<domain> + *.<domain> + <domain>
# =============================================================================

# The wildcard does not match the bare apex, so the apex is an explicit SAN: a
# future web deploy on AWS (#30) then needs no certificate change.
resource "aws_acm_certificate" "main" {
  for_each = local.served_domains

  domain_name               = "api.${each.key}"
  subject_alternative_names = ["*.${each.key}", each.key]
  validation_method         = "DNS"

  tags = {
    Name = "${local.name_prefix}-cert-${each.key}"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records, flattened across all served certificates. Keyed by
# the validated name (unique across domains), so the existing capyhoops keys
# are unchanged. ACM's validation CNAME for a given name is stable per account,
# so re-issuing a certificate does not alter these records.
locals {
  cert_validation_records = merge([
    for d, cert in aws_acm_certificate.main : {
      for dvo in cert.domain_validation_options : dvo.domain_name => {
        domain = d
        name   = dvo.resource_record_name
        record = dvo.resource_record_value
        type   = dvo.resource_record_type
      }
    }
  ]...)
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.cert_validation_records

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = aws_route53_zone.main[each.value.domain].zone_id
}

resource "aws_acm_certificate_validation" "main" {
  for_each = local.served_domains

  certificate_arn = aws_acm_certificate.main[each.key].arn
  validation_record_fqdns = [
    for k, r in aws_route53_record.cert_validation : r.fqdn
    if local.cert_validation_records[k].domain == each.key
  ]
}

# =============================================================================
# Route53 A Records — api.<domain> → ALB
# =============================================================================

resource "aws_route53_record" "api" {
  for_each = local.served_domains

  zone_id = aws_route53_zone.main[each.key].zone_id
  name    = "api.${each.key}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# =============================================================================
# CAA — only Amazon's CAs may issue certificates for these names (#758)
# =============================================================================

# ACM checks CAA before every issuance and renewal; its four CA identities are
# the ones listed. Every other public CA refuses a hooplings.com name before
# issuing, so a stray DNS-01 / HTTP-01 challenge (a compromised third party
# behind a future CNAME, a briefly hijacked registrar login) cannot end in a
# browser-trusted certificate. `issuewild` is needed because
# aws_acm_certificate.main requests *.<domain>. A certificate issued anywhere
# else for one of these zones (the web deploy, #30, if it lands outside AWS)
# needs that host's CA added here IN THE SAME PR, or its issuance fails on
# CAA. Applies to every zone, served or not. Pinned by
# backend/tests/infra/dns-caa.test.ts.
resource "aws_route53_record" "caa" {
  for_each = var.domains

  zone_id = aws_route53_zone.main[each.key].zone_id
  name    = each.key
  type    = "CAA"
  ttl     = 3600
  records = [
    "0 issue \"amazon.com\"",
    "0 issue \"amazontrust.com\"",
    "0 issue \"awstrust.com\"",
    "0 issue \"amazonaws.com\"",
    "0 issuewild \"amazon.com\"",
    "0 issuewild \"amazontrust.com\"",
    "0 issuewild \"awstrust.com\"",
    "0 issuewild \"amazonaws.com\"",
    "0 iodef \"mailto:${var.alert_email}\"",
  ]
}

# =============================================================================
# DNSSEC — sign every zone (#758)
# =============================================================================
#
# Two phases, and only the first is Terraform:
#   1. This file: one KMS key (shared by every zone), a key-signing key per
#      zone, signing enabled. Without a DS record at the registrar the zone is
#      an "insecure delegation": resolvers treat it exactly as before.
#   2. The owner publishes each zone's DS at Route 53 Domains, no earlier than
#      48 h after the apply that enabled signing (the apex NS TTL is 172800 s,
#      and AWS says to let every cached unsigned answer expire first). Steps
#      and verification: infra/README.md "CAA and DNSSEC".
#
# Once a DS is published, DISABLING signing, DEACTIVATING a key-signing key or
# DELETING / DISABLING the KMS key makes every validating resolver (Google,
# Cloudflare, Quad9, most ISPs) answer SERVFAIL for the whole zone. Hence
# prevent_destroy on all three (pinned by prevent-destroy.test.ts) and a 30-day
# KMS deletion window. Retiring DNSSEC is the reverse order: remove the DS at
# the registrar, wait 48 h, then lift the guards and disable signing.

resource "aws_kms_key" "dnssec" {
  description              = "${local.name_prefix} Route 53 DNSSEC key-signing key (every zone in var.domains)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30

  # The policy AWS documents for Route 53 DNSSEC: the service may describe,
  # read the public key and sign (scoped to this account's hosted zones) and
  # create the grant it needs; the account root keeps full control.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowRoute53DnssecService"
        Effect    = "Allow"
        Principal = { Service = "dnssec-route53.amazonaws.com" }
        Action    = ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign"]
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:route53:::hostedzone/*" }
        }
      },
      {
        Sid       = "AllowRoute53DnssecServiceCreateGrant"
        Effect    = "Allow"
        Principal = { Service = "dnssec-route53.amazonaws.com" }
        Action    = "kms:CreateGrant"
        Resource  = "*"
        Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
      },
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
    ]
  })

  tags = {
    Name = "${local.name_prefix}-dnssec"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_key_signing_key" "main" {
  for_each = var.domains

  hosted_zone_id             = aws_route53_zone.main[each.key].zone_id
  key_management_service_arn = aws_kms_key.dnssec.arn
  # Route 53 allows letters, digits and underscores in a KSK name.
  name = replace(each.key, ".", "_")

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_hosted_zone_dnssec" "main" {
  for_each = var.domains

  hosted_zone_id = aws_route53_key_signing_key.main[each.key].hosted_zone_id

  lifecycle {
    prevent_destroy = true
  }
}
