# Daily Upgrade Scan Routine

An autonomous Claude Code [routine](https://code.claude.com/docs/en/routines) that runs daily, triages dependency and security updates, opens PRs for safe changes (with auto-merge enabled for the narrowest categories), and posts a daily summary as a comment on a rolling GitHub issue.

## Schedule

- **Cron**: `0 15 * * *` (1500 UTC daily)
- **Local time**: 08:00 PT in summer (PDT, UTC−7), 07:00 PT in winter (PST, UTC−8)

## What it does

| Bucket | Examples | Action |
| --- | --- | --- |
| **Auto-fix** | High/critical Dependabot alerts (via `overrides`); caret-range patch bumps; Expo SDK same-major patch bumps | Branch + tests + PR + `gh pr merge --auto --squash` |
| **Needs-review** | Backend minor bumps; mobile non-RN minor bumps | PR labeled `needs-human`; awaits manual merge |
| **Defer** | Anything in the inline deferral list (Jest 30, RN ecosystem, RN majors, prisma generator migration) | Tracked in a single rolling issue; never auto-bumped |

The routine batches all eligible items per side (backend, mobile) into one PR per category — never multiple PRs for the same package.

## Daily output

- Zero or more PRs (`claude/auto-deps-*` or `claude/review-deps-*` branches)
- One updated issue: **Deferred dependency upgrades** (rolling list, body replaced each run)
- One new comment on the **Daily upgrade scan log** issue (rolling per-day log; you receive an email per comment via your repo Watch settings)

## Prerequisites

These are one-time setup items. All are already in place as of this routine going live:

1. ✅ Repo settings: `allow_auto_merge: true`, `delete_branch_on_merge: true`
2. ✅ Repo Watch with at least "Issues" notifications enabled (for the daily-log email)
3. ✅ Claude GitHub App installed on `deasystephen/bball-tracker` with write access to contents, issues, and pull requests

## Routine prompt

This is the exact prompt configured in `/schedule`. To modify the routine, edit it via `/schedule` and update this file in the same PR so they stay in sync.

```text
# Daily Upgrade Scan — bball-tracker

You run once daily at 1500 UTC (08:00 PT summer / 07:00 PT winter). Repo
deasystephen/bball-tracker is pre-cloned at the working directory; default
branch is `main`. Backend lives in ./backend, mobile in ./mobile. Read
CLAUDE.md for project conventions.

## Inline deferral list (authoritative)

NEVER bump these. Surface them in the deferred tracking issue + daily
log only.

  Backend:
    - jest, @types/jest          (waiting for v30 perf regression fix)
    - prisma-client generator    (migration from prisma-client-js;
                                  needs import path changes)

  Mobile (RN ecosystem — defer all until next Expo SDK upgrade):
    - react-native, @react-native-async-storage/async-storage
    - @react-native-community/datetimepicker
    - react-native-gesture-handler, react-native-reanimated
    - react-native-safe-area-context, react-native-screens
    - react-native-svg, react-native-worklets
    - jest, @types/jest

If a candidate matches → DEFER.

## Step 1 — Inventory (parallel)

  - gh api repos/deasystephen/bball-tracker/dependabot/alerts \
      --paginate --jq '.[] | select(.state=="open")'
  - cd backend && npm install && npm outdated --json
  - cd mobile  && npm install && npm outdated --json
  - gh pr list --state open --search "in:title chore(deps)" \
      --json number,title,headRefName
  - gh issue list --state open \
      --search "Deferred dependency upgrades" --json number,title
  - gh issue list --state open \
      --search "Daily upgrade scan log" --json number,title

Skip any candidate that already has an open PR with a matching title
prefix (idempotency).

## Step 2 — Categorize

AUTO-FIX (one batched PR per side; auto-merge enabled):
  - Open Dependabot alerts severity high/critical → fix via
    package.json `overrides` field
  - npm outdated entries where `current ≠ wanted` AND `wanted` is
    within the existing caret range (lockfile-only patch bumps)
  - Expo SDK same-major patch bumps in mobile (55.0.X → 55.0.Y)

NEEDS-REVIEW (one batched PR per side; label `needs-human`;
no auto-merge):
  - Backend minor bumps in same major not in DEFER list
  - Mobile minor bumps in same major NOT in the RN-ecosystem
    defer list

DEFER:
  - Anything in the deferral list above
  - Any major bump
  - When unsure

## Step 3 — Apply each AUTO-FIX bucket (one PR per side)

For each side with ≥1 auto-fix item:
  1. git checkout -b claude/auto-deps-<side>-YYYY-MM-DD
  2. Apply ALL items for that side in one branch:
       overrides: edit package.json `overrides`, then npm install
       caret patches: npm install <pkg>@<wanted> (chained args ok)
  3. Quality gates:
       backend: npm run type-check && npm test
       mobile : npm run type-check && npm test \
                && npx expo export --platform ios --output-dir /tmp/v
  4. DIFF GUARD — git diff --name-only must contain ONLY:
       <side>/package.json  and/or  <side>/package-lock.json
     Anything else → abort whole batch → "needs-attention"
  5. Any quality gate fails → abort whole batch → "needs-attention"
  6. git commit -m "<conventional, with version table & CVE refs>"
  7. git push -u origin <branch>
  8. gh pr create --base main \
       --title "chore(deps): bump <side> patch deps (YYYY-MM-DD)" \
       --body "<table of versions, CVE refs, test results>"
  9. gh pr comment <url> --body "@claude review once"
  10. gh pr merge --auto --squash --delete-branch <url>

## Step 4 — Apply each NEEDS-REVIEW bucket

Same as Step 3, but:
  - Branch: claude/review-deps-<side>-YYYY-MM-DD
  - Skip step 10
  - After step 9: gh pr edit <url> --add-label needs-human
    (create the label first if missing)

## Step 5 — Deferred tracking issue

Find issue titled exactly "Deferred dependency upgrades" (state=open).
Create if missing (label: automation); REPLACE body if exists.
Body: bullet list of all DEFER items with current → latest versions
and the unblock condition from the deferral list.

## Step 6 — Expo SDK divergence sanity check (informational)

  cd mobile && npx expo install --check 2>&1

Capture any "should be updated" lines. Surface them in the daily log
under "📐 Expo SDK divergence" — do NOT act on them.

## Step 7 — Daily log as GitHub issue comment

Find OPEN issue in deasystephen/bball-tracker titled exactly
"Daily upgrade scan log".
  - Found     → post a new comment on it
  - Not found → create the issue (label: automation; body explains the
                rolling-log purpose), then post the day's results as
                the first comment

Comment body:

  ## YYYY-MM-DD scan — 🟢{X} 🟡{Y} ⏸{Z} ⚠{W}

  🟢 Auto-merging — N
    - <pkg> (X.Y → A.B): #<PR>

  🟡 Awaiting your review — N
    - <pkg> (X.Y → A.B): #<PR>

  ⚠ Needs attention — N
    - <pkg>: <failure reason>

  📐 Expo SDK divergence — N (informational)
    - <pkg> ahead of SDK 55 prescription

  ⏸ Deferred — N (see <link to deferred tracking issue>)

  ✅ All clean — only if all the above are empty/zero

If the routine itself errors, still post a comment titled
"## YYYY-MM-DD scan — ⚠ ROUTINE ERROR" with the error and partial state.

## Hard constraints

  - Never push to main
  - Never modify any file outside <side>/package.json or
    <side>/package-lock.json (enforced by diff guard)
  - Never disable lint, tests, coverage thresholds, or the diff guard
  - Never bypass --no-verify on commits
  - Never enable --auto on a NEEDS-REVIEW or DEFERRED PR
  - Never bump anything in the inline deferral list
  - Time budget ~30 min — prioritize: CVE alerts > auto-fix >
    needs-review > tracking issue > daily log
  - On any fatal error, still post the daily-log comment with a
    "⚠ ROUTINE ERROR" section so you know the routine ran
```

## Updating the deferral list

When a deferred dependency becomes safe to bump (e.g., Jest 30 perf regression is fixed), update **both** in the same PR:

1. The "Inline deferral list" section in this file
2. The corresponding section inside the routine's prompt via `/schedule`

The inline list inside the prompt is the source of truth at runtime — this file is the version-controlled mirror.

## Disabling the routine

`/schedule` → list routines → delete (or pause) the **Daily Upgrade Scan**. PRs the routine has already opened remain; auto-merge will still complete on any in-flight PRs.
