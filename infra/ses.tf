# Hooplings - SES Domain Identities, DKIM, custom MAIL FROM, DMARC
#
# For every served domain (`local.served_domains`, dns.tf):
#   - SES v2 domain identity `mail.<domain>` with Easy DKIM (3 CNAMEs)
#   - custom MAIL FROM domain `bounce.mail.<domain>` (SES requires a SUBDOMAIN
#     of the identity) with its MX + SPF records, so the envelope sender is
#     ours and SPF aligns under DMARC instead of passing for amazonses.com
#   - `_dmarc.mail.<domain>` TXT. The policy and the report address are the
#     locals in workspace.tf, shared with the apex record (#555). The primary
#     domain's record carries the `rua` tag once Google Workspace receives
#     mail at the apex; tightening to `p=quarantine` follows about 30 days of
#     clean reports.
#
# After apply, `MailFromAttributes.MailFromDomainStatus` must read SUCCESS for
# each identity. SES sandbox → production access is account-wide (#23).
#
# The configuration set, the suppression list and the bounce/complaint event
# pipeline are in ses-events.tf (#449).

# =============================================================================
# SES Domain Identities
# =============================================================================

resource "aws_sesv2_email_identity" "mail" {
  for_each = local.served_domains

  email_identity = "mail.${each.key}"

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = {
    Name = "${local.name_prefix}-ses-identity-${each.key}"
  }
}

# Custom MAIL FROM — without this SES uses an amazonses.com envelope sender and
# the MX/SPF records below do nothing (the pre-2026-09 configuration).
resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  for_each = local.served_domains

  email_identity         = aws_sesv2_email_identity.mail[each.key].email_identity
  mail_from_domain       = "bounce.${aws_sesv2_email_identity.mail[each.key].email_identity}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# =============================================================================
# Route53 DKIM CNAME records (3 per identity)
# =============================================================================

locals {
  ses_dkim_records = merge([
    for d in keys(local.served_domains) : {
      for i in range(3) : "${d}-${i}" => { domain = d, index = i }
    }
  ]...)
}

resource "aws_route53_record" "ses_dkim" {
  for_each = local.ses_dkim_records

  zone_id = aws_route53_zone.main[each.value.domain].zone_id
  name    = "${aws_sesv2_email_identity.mail[each.value.domain].dkim_signing_attributes[0].tokens[each.value.index]}._domainkey.mail.${each.value.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.mail[each.value.domain].dkim_signing_attributes[0].tokens[each.value.index]}.dkim.amazonses.com"]
}

# =============================================================================
# MAIL FROM records — MX (bounce/complaint feedback) + SPF, at bounce.mail.<d>
# =============================================================================

resource "aws_route53_record" "ses_mail_from_mx" {
  for_each = local.served_domains

  zone_id = aws_route53_zone.main[each.key].zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.mail[each.key].mail_from_domain
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  for_each = local.served_domains

  zone_id = aws_route53_zone.main[each.key].zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.mail[each.key].mail_from_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

# =============================================================================
# DMARC — the sending subdomain
# =============================================================================

# Reports go to a mailbox on the primary domain, so only the primary domain's
# record names it: for any other served domain that address is external, and
# receivers send nothing to it without an authorization record
# (`<domain>._report._dmarc.<primary_domain>`).
resource "aws_route53_record" "ses_dmarc" {
  for_each = local.served_domains

  zone_id = aws_route53_zone.main[each.key].zone_id
  name    = "_dmarc.mail.${each.key}"
  type    = "TXT"
  ttl     = 300
  records = [
    local.workspace_enabled && each.key == var.primary_domain
    ? local.dmarc_record_with_reports
    : local.dmarc_record_no_reports
  ]
}

# =============================================================================
# IAM policy — allows the ECS task role to send via SES
# =============================================================================

# While the account is in the SES sandbox, SendEmail is authorized against the
# recipient's verified identity ARN as well as the sender's, so the resource
# must cover all identities; the FromAddress condition keeps the grant scoped
# to our sending domains.
#
# A send that names a configuration set is ALSO authorized against that set's
# ARN (#449). Without it every send from the API fails with AccessDenied the
# moment SES_CONFIGURATION_SET is deployed - the same shape as the 2026-08
# sandbox incident, where invitations were created and no email left.
data "aws_iam_policy_document" "ses_send" {
  statement {
    effect  = "Allow"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [
      "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
      aws_sesv2_configuration_set.transactional.arn,
    ]

    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = [for d in keys(local.served_domains) : "*@mail.${d}"]
    }
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
