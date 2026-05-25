# Basketball Tracker - SES Domain Identity and DKIM
#
# Provisions the SES v2 domain identity for mail.capyhoops.com,
# enables DKIM signing, and adds the required DNS records to Route53.
#
# After apply, verify the domain identity in the SES console
# and request production access (SES starts in sandbox mode).

# =============================================================================
# SES Domain Identity
# =============================================================================

resource "aws_sesv2_email_identity" "mail" {
  email_identity = "mail.${var.domain_name}"

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = {
    Name = "${local.name_prefix}-ses-identity"
  }
}

# =============================================================================
# Route53 DKIM CNAME records (3 records created by SES for DNS validation)
# =============================================================================

resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}._domainkey.mail.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# =============================================================================
# Route53 MX record — directs bounce/complaint mail to SES feedback endpoint
# =============================================================================

resource "aws_route53_record" "ses_mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "mail.${var.domain_name}"
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

# =============================================================================
# Route53 TXT record — SPF policy
# =============================================================================

resource "aws_route53_record" "ses_spf" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "mail.${var.domain_name}"
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

# =============================================================================
# IAM policy — allows the ECS task role to send via SES
# =============================================================================

data "aws_iam_policy_document" "ses_send" {
  statement {
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [aws_sesv2_email_identity.mail.arn]
  }
}

resource "aws_iam_policy" "ses_send" {
  name        = "${local.name_prefix}-ses-send"
  description = "Allow ECS tasks to send transactional email via SES"
  policy      = data.aws_iam_policy_document.ses_send.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_ses" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ses_send.arn
}
