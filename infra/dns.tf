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
# State moves — the pre-2026-09 single-domain resources keep their objects
# =============================================================================

moved {
  from = aws_route53_zone.main
  to   = aws_route53_zone.main["capyhoops.com"]
}

moved {
  from = aws_acm_certificate.main
  to   = aws_acm_certificate.main["capyhoops.com"]
}

moved {
  from = aws_acm_certificate_validation.main
  to   = aws_acm_certificate_validation.main["capyhoops.com"]
}

moved {
  from = aws_route53_record.api
  to   = aws_route53_record.api["capyhoops.com"]
}
