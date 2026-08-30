#!/usr/bin/env bash
# Create the "Hooplings GA" Project board and add every v2.0 GA milestone issue.
#
# Prerequisite (one time, interactive — run it yourself first):
#   gh auth refresh -s project
#
# Then:
#   ./scripts/setup-ga-board.sh
#
# Idempotent-ish: re-running creates a SECOND board. If you need to re-run,
# delete the first one at https://github.com/users/deasystephen/projects
set -euo pipefail

OWNER="deasystephen"
REPO="deasystephen/bball-tracker"
TITLE="Hooplings GA"
MILESTONE="v2.0 GA"

if ! gh auth status 2>&1 | grep -q "project"; then
  echo "ERROR: the 'project' scope is missing from your gh token." >&2
  echo "Run:  gh auth refresh -s project" >&2
  exit 1
fi

echo "==> Creating project '$TITLE'"
PROJECT_URL=$(gh project create --owner "$OWNER" --title "$TITLE" --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
PROJECT_NUM="${PROJECT_URL##*/}"
echo "    $PROJECT_URL (number $PROJECT_NUM)"

echo "==> Adding '$MILESTONE' issues"
gh issue list --repo "$REPO" --milestone "$MILESTONE" --state open --limit 100 --json url --jq '.[].url' \
  | while read -r url; do
      echo "    + $url"
      gh project item-add "$PROJECT_NUM" --owner "$OWNER" --url "$url"
    done

cat <<EOF

==> Done. Finish in the UI at $PROJECT_URL

Two manual steps the CLI cannot do well:

  1. Rename the default "Status" field options to:
         Waiting on external | Ready | In progress | In review | Done
     "Waiting on external" is the one that earns the board — five GA blockers
     are queued behind AWS, Apple, and counsel, and a milestone cannot express
     "blocked on someone else".

  2. Sort the board by the "Status" field and set the default view to Board.

Suggested starting placement:
  Waiting on external -> #23 (SES access), #24 (WorkOS env), #25 (legal),
                         #450 (support inbox), #451 (App Store metadata)
  Ready               -> #53, #446, #447, #442, #443, #444, #445, #448, #449
  Blocked on ordering -> #30 (needs #447 deployed first)
EOF
