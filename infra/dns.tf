# Basketball Tracker - Route53 DNS + ACM Certificate
#
# Manages the capyhoops.com hosted zone, ACM certificate with DNS validation,
# and the api.capyhoops.com A record pointing to the ALB.
#
# After `terraform apply`, update your domain registrar's NS records
# with the values from `terraform output name_servers`.

# =============================================================================
# Route53 Hosted Zone
# =============================================================================

resource "aws_route53_zone" "main" {
  name = var.domain_name

  tags = {
    Name = "${local.name_prefix}-dns"
  }
}

# =============================================================================
# ACM Certificate — api.capyhoops.com + wildcard
# =============================================================================

resource "aws_acm_certificate" "main" {
  domain_name               = "api.${var.domain_name}"
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  tags = {
    Name = "${local.name_prefix}-cert"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records — automatically created from ACM's challenges
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# =============================================================================
# Route53 A Record — api.capyhoops.com → ALB
# =============================================================================

resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
