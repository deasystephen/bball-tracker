# Hooplings - Google Workspace mail on the apex (#555)
#
# People read mail at `<primary_domain>` (support@, privacy@, alerts@, dmarc@),
# through Google Workspace. The application sends from a DIFFERENT name,
# `mail.<domain>`, through SES (ses.tf). The two paths share nothing:
#
#   | Name                  | Sender           | SPF                      | DKIM                |
#   | --------------------- | ---------------- | ------------------------ | ------------------- |
#   | <primary_domain>      | Google Workspace | include:_spf.google.com  | google._domainkey   |
#   | mail.<domain>         | Amazon SES       | include:amazonses.com    | 3 Easy DKIM CNAMEs  |
#
# Keep it that way. Do not add SES to the apex SPF and do not add Google to the
# `mail.` subdomain: separate names are what keep the DMARC alignment of one
# path independent of the other.
#
# Everything here is off until `google_site_verification` is set, so the file
# plans to "No changes" before the Workspace account exists. The records come
# in two applies, because Google generates the DKIM key only after Gmail has
# been active for a while (24 to 72 hours):
#
#   1. `google_site_verification` set  -> verification + SPF, MX, apex DMARC,
#                                         and the `rua` tag on `_dmarc.mail.`
#   2. `google_dkim_public_key` set    -> the DKIM record
#
# Neither value is a secret (both are published in DNS), so they are committed
# as the variable defaults below, not kept in terraform.tfvars.
#
# Variables live in this file (same pattern as alerting.tf and datadog.tf).

locals {
  workspace_enabled = var.google_site_verification != ""

  # Aggregate DMARC reports for the apex AND for `mail.<primary_domain>`. It is
  # a mailbox on the same organizational domain as both records, so no
  # external-reporting authorization record is needed.
  dmarc_report_address = "dmarc@${var.primary_domain}"

  # One policy for both DMARC records. Tighten to "quarantine" only after about
  # 30 days of aggregate reports show nothing but aligned mail from Google
  # (apex) and SES (`mail.`): see docs/runbooks/email-deliverability.md.
  dmarc_policy = "none"

  dmarc_record_with_reports = "v=DMARC1; p=${local.dmarc_policy}; rua=mailto:${local.dmarc_report_address}"
  dmarc_record_no_reports   = "v=DMARC1; p=${local.dmarc_policy}"

  # A TXT string holds at most 255 characters and a 2048-bit DKIM key is about
  # 400. The provider writes one value as several strings when the pieces are
  # joined with `""`.
  google_dkim_chunks = [
    for start in range(0, length(var.google_dkim_public_key), 255) :
    substr(var.google_dkim_public_key, start, 255)
  ]
}

# =============================================================================
# Apex TXT - SPF and the Google domain verification, one record set
# =============================================================================

# Route 53 holds every TXT value of a name in ONE record set. A future TXT at
# the apex (another verification, for example) is a new entry in this list,
# never a second resource.
resource "aws_route53_record" "workspace_apex_txt" {
  count = local.workspace_enabled ? 1 : 0

  zone_id = aws_route53_zone.main[var.primary_domain].zone_id
  name    = var.primary_domain
  type    = "TXT"
  ttl     = 300
  records = [
    "v=spf1 include:_spf.google.com ~all",
    var.google_site_verification,
  ]
}

# =============================================================================
# Apex MX - inbound mail to Google
# =============================================================================

resource "aws_route53_record" "workspace_mx" {
  count = local.workspace_enabled ? 1 : 0

  zone_id = aws_route53_zone.main[var.primary_domain].zone_id
  name    = var.primary_domain
  type    = "MX"
  ttl     = 300
  records = var.google_mx_records
}

# =============================================================================
# DKIM - google._domainkey
# =============================================================================

resource "aws_route53_record" "workspace_dkim" {
  count = local.workspace_enabled && var.google_dkim_public_key != "" ? 1 : 0

  zone_id = aws_route53_zone.main[var.primary_domain].zone_id
  name    = "${var.google_dkim_selector}._domainkey.${var.primary_domain}"
  type    = "TXT"
  ttl     = 300
  records = [join("\"\"", local.google_dkim_chunks)]
}

# =============================================================================
# DMARC - the apex
# =============================================================================

# `_dmarc.mail.<domain>` is in ses.tf and reads the same locals.
resource "aws_route53_record" "workspace_dmarc" {
  count = local.workspace_enabled ? 1 : 0

  zone_id = aws_route53_zone.main[var.primary_domain].zone_id
  name    = "_dmarc.${var.primary_domain}"
  type    = "TXT"
  ttl     = 300
  records = [local.dmarc_record_with_reports]
}

# =============================================================================
# Variables
# =============================================================================

variable "google_site_verification" {
  description = "Domain verification value from the Google Workspace setup, in full (`google-site-verification=...`). Empty = no Workspace records at all."
  type        = string
  default     = "google-site-verification=n83bYCDNtnKeYlrgnTaTzhjQ_yMw3_sAHl1gFfva7Eg"

  validation {
    condition     = var.google_site_verification == "" || can(regex("^google-site-verification=[A-Za-z0-9_-]+$", var.google_site_verification))
    error_message = "Must be empty or the full value Google shows, starting with `google-site-verification=`."
  }
}

variable "google_dkim_public_key" {
  description = "DKIM TXT value from the Google admin console (Gmail > Authenticate email), in full and as ONE string with no quotes or spaces inside the key (`v=DKIM1; k=rsa; p=...`). Empty = no DKIM record."
  type        = string
  default     = ""

  validation {
    condition     = var.google_dkim_public_key == "" || can(regex("^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$", var.google_dkim_public_key))
    error_message = "Must be empty or `v=DKIM1; k=rsa; p=<base64 key>` as one string. Remove the quotes and line breaks the admin console shows inside a long key."
  }
}

variable "google_dkim_selector" {
  description = "DKIM selector chosen in the Google admin console. `google` is the console's default."
  type        = string
  default     = "google"
}

variable "google_mx_records" {
  description = "MX values for Google Workspace. Accounts created since 2023 use the single record below; an older account uses the five ASPMX records."
  type        = list(string)
  default     = ["1 smtp.google.com"]
}
