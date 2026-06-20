#!/bin/bash

# SES Test-Recipient Verification Helper (E2E v2.0)
#
# In the SES sandbox you can only send to verified recipients, and verifying the
# base inbox does NOT cover its `+alias` addresses — each alias must be verified
# on its own. This helper registers (or checks the status of) the email-receiving
# personas from docs/testing/workos-test-accounts.md.
#
# Usage:
#   ./verify-ses-test-recipients.sh create   # request verification for each alias
#   ./verify-ses-test-recipients.sh status   # show VerifiedForSendingStatus per alias
#   ./verify-ses-test-recipients.sh          # defaults to "status"
#
# After "create", click the confirmation link in each email (they all land in the
# base inbox). Override the defaults with env vars, e.g.:
#   SES_REGION=us-west-2 BASE_LOCALPART=me BASE_DOMAIN=example.com ./verify-ses-test-recipients.sh create

set -euo pipefail

SES_REGION="${SES_REGION:-us-east-1}"
BASE_LOCALPART="${BASE_LOCALPART:-deasystephen}"
BASE_DOMAIN="${BASE_DOMAIN:-gmail.com}"

# Only the personas that need to RECEIVE mail (see the test-account guide).
# The boundary-only personas (asstcoach, manager, outsider) don't need SES.
ALIASES=(headcoach player parent invitee2)

email_for() { echo "${BASE_LOCALPART}+${1}@${BASE_DOMAIN}"; }

require_aws() {
    if ! command -v aws >/dev/null 2>&1; then
        echo "❌ aws CLI not found. Install it and configure credentials first."
        exit 1
    fi
}

do_create() {
    echo "📧 Requesting SES verification (region: ${SES_REGION})..."
    echo ""
    for alias in "${ALIASES[@]}"; do
        addr="$(email_for "$alias")"
        printf '   %-42s ' "$addr"
        if aws sesv2 create-email-identity \
            --email-identity "$addr" --region "$SES_REGION" >/dev/null 2>&1; then
            echo "requested ✅"
        else
            # Already-existing identities return an error — not fatal, just report it.
            echo "already requested or failed (check status) ⚠️"
        fi
    done
    echo ""
    echo "👉 Now open each verification email in the ${BASE_LOCALPART}@${BASE_DOMAIN} inbox and click the link."
    echo "   Then run: $0 status"
}

do_status() {
    echo "🔍 SES verification status (region: ${SES_REGION})..."
    echo ""
    local all_verified=1
    for alias in "${ALIASES[@]}"; do
        addr="$(email_for "$alias")"
        printf '   %-42s ' "$addr"
        status="$(aws sesv2 get-email-identity \
            --email-identity "$addr" --region "$SES_REGION" \
            --query 'VerifiedForSendingStatus' --output text 2>/dev/null || echo 'NOT_FOUND')"
        case "$status" in
            True)  echo "verified ✅" ;;
            False) echo "pending (click the confirmation email) ⏳"; all_verified=0 ;;
            *)     echo "not requested — run '$0 create' ❌"; all_verified=0 ;;
        esac
    done
    echo ""
    if [ "$all_verified" -eq 1 ]; then
        echo "✅ All test recipients verified — email-receiving tests are good to go."
    else
        echo "⚠️  Some recipients are not verified yet. Sends to them will be rejected in the SES sandbox."
    fi
}

require_aws
case "${1:-status}" in
    create) do_create ;;
    status) do_status ;;
    *) echo "Usage: $0 [create|status]"; exit 1 ;;
esac
