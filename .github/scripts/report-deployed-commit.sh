#!/usr/bin/env bash
#
# Reads the commit production reports on /health and compares it with the one
# a deploy was meant to ship (#570). Prints Markdown for the job summary.
#
# Usage:  .github/scripts/report-deployed-commit.sh <health-url> <expected-sha> [attempts] [seconds-between]
#
# During the overlap of a rollout the old task may still answer, so it asks
# again until the commit matches or the attempts run out (12 x 10s by default).
# It always exits 0: the deploy has already been judged by the step that waits
# for the service to become stable, and this only reports.

set -uo pipefail

HEALTH_URL="${1:-}"
EXPECTED="${2:-}"
ATTEMPTS="${3:-12}"
PAUSE="${4:-10}"

reported=""
for attempt in $(seq 1 "$ATTEMPTS"); do
  reported="$(curl -fsS -m 10 "$HEALTH_URL" 2>/dev/null | jq -r '.commit // empty' 2>/dev/null || true)"
  [ -n "$EXPECTED" ] && [ "$reported" = "$EXPECTED" ] && break
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$PAUSE"
done

echo
echo "## After the deploy"
echo
if [ -n "$EXPECTED" ] && [ "$reported" = "$EXPECTED" ]; then
  printf '%s reports commit \140%s\140, the one this job deployed.\n' "$HEALTH_URL" "$reported"
else
  printf '**%s reports commit \140%s\140, not \140%s\140.** Check whether the rollout was rolled back.\n' \
    "$HEALTH_URL" "${reported:-none}" "${EXPECTED:-none given}"
fi
exit 0
