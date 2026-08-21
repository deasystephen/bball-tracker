#!/bin/bash

# SES Test-Recipient Verification Helper (E2E v2.0)
#
# In the SES sandbox you can only send to verified recipients, and verifying the
# base inbox does NOT cover its `+alias` addresses — each alias must be verified
# on its own. This helper registers (or checks the status of) the email-receiving
# personas from docs/testing/workos-test-accounts.md for one or more tester inboxes.
#
# Usage:
#   ./verify-ses-test-recipients.sh create   # request verification for each alias
#   ./verify-ses-test-recipients.sh status   # show VerifiedForSendingStatus per alias
#   ./verify-ses-test-recipients.sh          # defaults to "status"
#
# Tester inboxes come from TEST_ACCOUNTS (comma- or space-separated base addresses,
# no "+alias" — personas are appended automatically). Default: the original inbox.
#   TEST_ACCOUNTS="deasystephen@gmail.com tester@example.com" ./verify-ses-test-recipients.sh create
#   SES_REGION=us-west-2 ./verify-ses-test-recipients.sh status
#
# After "create", each tester must click the confirmation link in the emails that
# land in their own inbox (Gmail delivers all +aliases to the base inbox).

set -euo pipefail

SES_REGION="${SES_REGION:-us-east-1}"
TEST_ACCOUNTS="${TEST_ACCOUNTS:-deasystephen@gmail.com}"

# Only the personas that need to RECEIVE mail (see the test-account guide).
# The boundary-only personas (asstcoach, manager, outsider) don't need SES.
ALIASES=(headcoach player parent invitee2)

# Split TEST_ACCOUNTS on commas/semicolons/whitespace, lowercase, de-duplicate.
ACCOUNTS=()
while IFS= read -r acct; do
    [ -n "$acct" ] && ACCOUNTS+=("$acct")
done < <(tr ',;' '  ' <<<"$TEST_ACCOUNTS" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '\n' | awk 'NF && !seen[$0]++')

if [ "${#ACCOUNTS[@]}" -eq 0 ]; then
    echo "❌ TEST_ACCOUNTS is empty — set it to one or more base addresses (e.g. name@example.com)."
    exit 1
fi
for acct in "${ACCOUNTS[@]}"; do
    case "$acct" in
        *+*@*|*@*@*|@*|*@|*[!A-Za-z0-9._%@-]*)
            echo "❌ Invalid base account \"$acct\" — expected a plain address like name@example.com (no +alias)."
            exit 1 ;;
        *@*.*) ;;
        *)
            echo "❌ Invalid base account \"$acct\" — expected a plain address like name@example.com."
            exit 1 ;;
    esac
done

email_for() { echo "${1%@*}+${2}@${1#*@}"; }

require_aws() {
    if ! command -v aws >/dev/null 2>&1; then
        echo "❌ aws CLI not found. Install it and configure credentials first."
        exit 1
    fi
}

do_create() {
    echo "📧 Requesting SES verification (region: ${SES_REGION})..."
    for acct in "${ACCOUNTS[@]}"; do
        echo ""
        echo "  ${acct}:"
        for alias in "${ALIASES[@]}"; do
            addr="$(email_for "$acct" "$alias")"
            printf '   %-42s ' "$addr"
            if aws sesv2 create-email-identity \
                --email-identity "$addr" --region "$SES_REGION" >/dev/null 2>&1; then
                echo "requested ✅"
            else
                # Already-existing identities return an error — not fatal, just report it.
                echo "already requested or failed (check status) ⚠️"
            fi
        done
    done
    echo ""
    echo "👉 Now have each tester open the verification emails in their inbox and click the links:"
    for acct in "${ACCOUNTS[@]}"; do echo "   - ${acct}"; done
    echo "   Then run: $0 status"
}

do_status() {
    echo "🔍 SES verification status (region: ${SES_REGION})..."
    local all_verified=1
    for acct in "${ACCOUNTS[@]}"; do
        echo ""
        echo "  ${acct}:"
        for alias in "${ALIASES[@]}"; do
            addr="$(email_for "$acct" "$alias")"
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
