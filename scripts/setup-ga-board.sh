#!/usr/bin/env bash
# Create the "Hooplings GA" Project board, load every v2.0 GA milestone issue,
# rename the Status columns, and place each issue in the right one.
#
# Already run against https://github.com/users/deasystephen/projects/1 on
# 2026-08-30. Kept for reproducibility (rebuilding the board, or standing up an
# equivalent for a later milestone) — re-running creates a SECOND board.
#
# Prerequisite (one time, interactive):
#   gh auth refresh -s project
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
PROJECT_URL=$(gh project create --owner "$OWNER" --title "$TITLE" --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
PROJECT_NUM="${PROJECT_URL##*/}"
echo "    $PROJECT_URL (number $PROJECT_NUM)"

echo "==> Adding '$MILESTONE' issues"
gh issue list --repo "$REPO" --milestone "$MILESTONE" --state open --limit 100 \
    --json url --jq '.[].url' \
  | while read -r url; do
      echo "    + $url"
      gh project item-add "$PROJECT_NUM" --owner "$OWNER" --url "$url"
    done

# ---------------------------------------------------------------------------
# Status columns.
#
# "Waiting on external" is the column that earns the board: five GA blockers are
# queued behind AWS, Apple, and counsel, and a milestone cannot express "blocked
# on someone else". The default Todo/In Progress/Done cannot.
#
# NOTE: updateProjectV2Field replaces the option set and mints new option IDs,
# so any existing Status assignments are cleared. That is why placement below
# runs unconditionally afterwards.
# ---------------------------------------------------------------------------
echo "==> Renaming Status options"
read -r PROJECT_ID FIELD_ID <<<"$(gh api graphql -f query="
query {
  user(login: \"$OWNER\") {
    projectV2(number: $PROJECT_NUM) {
      id
      field(name: \"Status\") { ... on ProjectV2SingleSelectField { id } }
    }
  }
}" --jq '.data.user.projectV2 | "\(.id) \(.field.id)"')"

gh api graphql -f query="
mutation {
  updateProjectV2Field(input: {
    fieldId: \"$FIELD_ID\"
    singleSelectOptions: [
      {name: \"Waiting on external\", color: ORANGE, description: \"Blocked on AWS, Apple, or counsel — cannot be pushed\"}
      {name: \"Ready\",               color: BLUE,   description: \"Unblocked and specced; safe to pick up\"}
      {name: \"In progress\",         color: YELLOW, description: \"Actively being worked\"}
      {name: \"In review\",           color: PURPLE, description: \"PR open, awaiting review or CI\"}
      {name: \"Done\",                color: GREEN,  description: \"Merged and verified\"}
    ]
  }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
}" --silent

echo "==> Placing issues"
gh project item-list "$PROJECT_NUM" --owner "$OWNER" --limit 100 --format json > /tmp/ga-board-items.json
PROJECT_ID="$PROJECT_ID" FIELD_ID="$FIELD_ID" OWNER="$OWNER" PROJECT_NUM="$PROJECT_NUM" python3 - <<'PY' > /tmp/ga-board-assign.sh
import json, os, subprocess

# Issues gated on someone else's queue. Everything else is pickup-able.
WAITING = {23, 24, 25, 450, 451}

opts = json.loads(subprocess.run(
    ["gh", "api", "graphql", "-f", "query", f'''
    query {{ user(login: "{os.environ["OWNER"]}") {{
      projectV2(number: {os.environ["PROJECT_NUM"]}) {{
        field(name: "Status") {{ ... on ProjectV2SingleSelectField {{ options {{ id name }} }} }}
      }} }} }}''', "--jq", ".data.user.projectV2.field.options"],
    capture_output=True, text=True, check=True).stdout)
by_name = {o["name"]: o["id"] for o in opts}

for it in json.load(open("/tmp/ga-board-items.json"))["items"]:
    n = it.get("content", {}).get("number")
    if n is None:
        continue
    col = "Waiting on external" if n in WAITING else "Ready"
    print(
        "gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(input: {"
        f'projectId:"{os.environ["PROJECT_ID"]}" itemId:"{it["id"]}" '
        f'fieldId:"{os.environ["FIELD_ID"]}" '
        f'value:{{singleSelectOptionId:"{by_name[col]}"}}'
        "}) { projectV2Item { id } } }' --silent"
        f' && echo "    #{n} -> {col}"'
    )
PY
bash /tmp/ga-board-assign.sh
rm -f /tmp/ga-board-items.json /tmp/ga-board-assign.sh

cat <<EOF

==> Done: $PROJECT_URL

Everything above is applied. The one thing left is a view preference the API
does not expose: open the board and set the default view to "Board", grouped by
Status. Anything already underway needs moving to "In progress" by hand.

Ordering the columns do NOT encode — see ROADMAP.md:
  #53 -> #447 -> #30 -> #23 -> #24
Each link makes the next safe. Leaving SES sandbox (#23) before the web app is
deployed (#30), for instance, means working email carrying a dead link.
EOF
