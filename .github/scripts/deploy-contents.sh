#!/usr/bin/env bash
#
# What a deploy carries (#570).
#
# A deploy ships everything on main since the commit production is running,
# not only the change whose merge started it: backend bumps that Dependabot
# auto-merges start no CI run on main, so they wait on main and ride along
# with the next merge that deploys. This prints, as Markdown, the commits
# between the deployed commit and the new one that change what is deployed,
# and marks the ones that were merged earlier without a deploy.
#
# Usage:  .github/scripts/deploy-contents.sh <deployed-sha> <new-sha> [push-before-sha]
#
#   deployed-sha     the commit production runs now (the tag of its image)
#   new-sha          the commit about to be deployed
#   push-before-sha  the tip of main before the push that started this deploy
#                    (github.event.before). Commits up to it were merged
#                    earlier. Leave it out for a deploy started by hand.
#
# It only reads the repository. It always exits 0: a summary must never stop a
# deploy, so every problem is reported in the text instead.

set -uo pipefail

# The paths that make up the deployed image and its task definition. Keep in
# step with the `backend` filter of the detect-changes job in ci.yml.
DEPLOY_PATHS=(backend infra docker .github/workflows/ci.yml ':(exclude,glob)**/*.md')

DEPLOYED="${1:-}"
NEW="${2:-}"
PUSH_BEFORE="${3:-}"
REPO_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}"

short() { git rev-parse --short=7 "$1" 2>/dev/null || printf '%s' "${1:0:7}"; }
is_commit() { [ -n "$1" ] && git cat-file -e "${1}^{commit}" 2>/dev/null; }

# \140 is a backtick: the Markdown code mark, written so that the shell never
# reads it as a command substitution.
commit_link() {
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    printf '[\140%s\140](%s/commit/%s)' "$(short "$1")" "$REPO_URL" "$1"
  else
    printf '\140%s\140' "$(short "$1")"
  fi
}

# One list item per commit in <range> that touches the deploy paths.
list_commits() {
  local range="$1" sha date author subject
  git log --reverse --format='%H%x09%ad%x09%an%x09%s' --date=short "$range" -- "${DEPLOY_PATHS[@]}" |
    while IFS=$'\t' read -r sha date author subject; do
      printf -- '- %s %s, %s: %s\n' "$(commit_link "$sha")" "$date" "$author" "$subject"
    done
}

count_commits() { git rev-list --count "$1" -- "${DEPLOY_PATHS[@]}" 2>/dev/null || echo 0; }

echo "## What this deploy carries"
echo

if ! is_commit "$NEW"; then
  echo "The commit to deploy (\`${NEW:-none given}\`) is not in this clone, so the contents cannot be listed."
  exit 0
fi

if ! is_commit "$DEPLOYED"; then
  echo "New commit: $(commit_link "$NEW")."
  echo
  echo "**The commit production is running could not be read** (got \`${DEPLOYED:-nothing}\`), so the contents of this deploy are not listed. Compare by hand: \`curl -s https://api.hooplings.com/health\` gives the running commit."
  exit 0
fi

echo "Production runs $(commit_link "$DEPLOYED"). This deploy moves it to $(commit_link "$NEW")."
echo

if [ "$(git rev-parse "$DEPLOYED")" = "$(git rev-parse "$NEW")" ]; then
  echo "That is the same commit: this deploy rebuilds and restarts the service and changes no code."
  exit 0
fi

if ! git merge-base --is-ancestor "$DEPLOYED" "$NEW"; then
  echo "**The running commit is not an ancestor of the new one.** This deploy moves production to a commit that does not contain everything it runs now (a rollback, or a rewritten branch)."
  echo
  removed="$(list_commits "$NEW..$DEPLOYED")"
  if [ -n "$removed" ]; then
    echo "### Taken out of production"
    echo
    echo "$removed"
    echo
  fi
fi

total="$(count_commits "$DEPLOYED..$NEW")"
all="$(git rev-list --count "$DEPLOYED..$NEW")"

if [ "$all" -eq 0 ]; then
  # A rollback to an ancestor: nothing new goes in.
  exit 0
fi

if [ "$total" -eq 0 ]; then
  echo "None of the $all commits in between changes what is deployed (\`backend/\`, \`infra/\`, \`docker/\`, \`ci.yml\`; Markdown left out). The image is rebuilt from the same sources."
  exit 0
fi

# Split at the tip of main before this push: what lies before it was merged
# earlier and never deployed.
carried=""
if is_commit "$PUSH_BEFORE" &&
  git merge-base --is-ancestor "$DEPLOYED" "$PUSH_BEFORE" &&
  git merge-base --is-ancestor "$PUSH_BEFORE" "$NEW"; then
  carried="$(list_commits "$DEPLOYED..$PUSH_BEFORE")"
  started="$(list_commits "$PUSH_BEFORE..$NEW")"

  echo "### The change that started this deploy"
  echo
  if [ -n "$started" ]; then echo "$started"; else echo "None of its commits changes what is deployed."; fi
  echo
  echo "### Merged earlier without a deploy, shipped now"
  echo
  if [ -n "$carried" ]; then
    echo "$carried"
  else
    echo "Nothing. Production was level with \`main\` before this change."
  fi
else
  echo "### Commits that change what is deployed"
  echo
  list_commits "$DEPLOYED..$NEW"
fi

echo
echo "Commits since the running one: $all. Of those, changing what is deployed: $total."
if [ -n "$carried" ]; then
  echo
  echo "> If this deploy misbehaves, the cause may be one of the commits merged earlier, not the change that started it."
fi
exit 0
