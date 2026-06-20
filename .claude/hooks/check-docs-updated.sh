#!/usr/bin/env bash
# Stop hook: remind to update docs when code changed but docs did not.
#
# Non-blocking by design — it only surfaces a reminder; it never prevents the
# session from stopping and never edits anything. Fires on the Stop event,
# inspects the working tree, and warns when source files changed without a
# corresponding update to docs/ or CLAUDE.md.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$root" ] && exit 0
cd "$root" || exit 0

# Tracked (staged + unstaged) changes vs HEAD, plus untracked files.
changed="$({ git diff --name-only HEAD 2>/dev/null || true; \
             git ls-files --others --exclude-standard 2>/dev/null || true; } | sort -u)"
[ -z "$changed" ] && exit 0

# If any documentation changed, assume docs were considered — stay quiet.
docs_changed="$(printf '%s\n' "$changed" | grep -E '(^|/)CLAUDE\.md$|^docs/|\.md$' || true)"
[ -n "$docs_changed" ] && exit 0

# Only nudge when actual source files changed (backend/mobile/web code).
code_changed="$(printf '%s\n' "$changed" | grep -E '^(backend|mobile|web)/.*\.(ts|tsx|js|jsx|mjs|cjs|prisma)$' || true)"
[ -z "$code_changed" ] && exit 0

count="$(printf '%s\n' "$code_changed" | sed '/^$/d' | wc -l | tr -d ' ')"
msg="Docs check: ${count} code file(s) changed in the working tree but no docs/ or CLAUDE.md updates. Verify whether documentation needs updating before wrapping up."

# Non-blocking reminder: shown to the user and injected into model context.
printf '{"systemMessage": "%s", "hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "%s"}}' "$msg" "$msg"
