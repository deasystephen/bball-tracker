# Daily Upgrade Scan — bball-tracker

You are running inside GitHub Actions (`.github/workflows/daily-upgrade-scan.yml`)
on a checkout of `deasystephen/bball-tracker` at `main`. `gh` is installed and
authenticated; `git push` / `gh pr create` / `gh issue comment` all work. Read
`CLAUDE.md` for project conventions. Backend lives in `./backend`, mobile in
`./mobile`, web in `./web`.

The workflow passes you three environment facts in the prompt: `ALERTS_JSON`
(path to a pre-fetched snapshot of open Dependabot alerts), `TODAY` (ISO
timestamp), `DRY_RUN`, and `RUN_URL`. Never call the Dependabot alerts API
yourself — it is not reachable with your token; the snapshot is authoritative.

## Division of labour (what you do NOT do)

Dependabot (`.github/dependabot.yml`) plus `.github/workflows/dependabot-auto-merge.yml`
own the mechanical version bumps for **backend and web** (patch + minor auto-merge)
and **mobile patch** bumps. Do not open competing PRs for those; if one is
already open from Dependabot, leave it alone. You exist for the parts that need
judgment:

1. **Security overrides** for vulnerable transitive deps (all three sides).
2. **Mobile caret-range patch bumps** — Dependabot's regenerated mobile lockfile
   drops `overrides` entries and fails `npm ci` (see PR #290 / #300), so mobile
   lockfile-only bumps are yours.
3. **Deferral-list upkeep** and the **daily log**.

## Inline deferral list (authoritative)

NEVER bump these. Surface them in the deferred tracking issue + daily log only.

  Backend:
    - jest, @types/jest          (waiting for v30 perf regression fix)
    - prisma-client generator    (migration from prisma-client-js; needs import path changes)

  Mobile (RN ecosystem — defer all until the next Expo SDK upgrade):
    - react-native, @react-native-async-storage/async-storage
    - @react-native-community/datetimepicker
    - react-native-gesture-handler, react-native-reanimated
    - react-native-safe-area-context, react-native-screens
    - react-native-svg, react-native-worklets
    - lottie-react-native >= 7.4 (needs RN >= 0.84)
    - jest, @types/jest

## Step 1 — Inventory

  - cat "$ALERTS_JSON"            (open alerts: severity, package, manifest,
                                   vulnerable_range, first_patched, html_url)
  - cd mobile && npm ci && npm outdated --json
  - cd backend && npm ci          (only needed if a backend override is required)
  - cd web && npm ci              (only needed if a web override is required)
  - gh pr list --state open --search "in:title chore(deps)" --json number,title,headRefName,author
  - gh issue list --state open --search "Deferred dependency upgrades" --json number,title
  - gh issue list --state open --search "Daily upgrade scan log" --json number,title

If `ALERTS_JSON` contains `{"error": ...}`, say so under ⚠ Needs attention and
fall back to `npm audit --json` per side for the security bucket.

Skip any candidate that already has an open PR with a matching title prefix
(idempotency).

## Step 2 — Categorize

### Security (from the alerts snapshot) — decide per alert

For each open alert with severity **high** or **critical** (moderate/low: list
under ⏸ only):

  a. `first_patched` is non-null → **AUTO-FIX via override**, regardless of what
     `npm audit` says about the fix path. A root `overrides` entry in
     `<side>/package.json` patches the nested copy even when the direct parent
     (e.g. `eas-cli`, `expo`, `next`) would otherwise need a major bump. Use the
     narrowest range that satisfies the alert: `"<pkg>": "^<first_patched>"`.
     If two vulnerable major lines coexist (e.g. js-yaml 3.x and 4.x), scope
     the override to the parent (`"<parent>": { "<pkg>": "^x.y.z" }`) or use one
     entry per line — never force a major jump on the nested package.
     Exception: if the patched version's major differs from every installed
     copy AND the parent's peer range forbids it → ⚠ Needs attention.
  b. `first_patched` is null → **no upstream fix**. Do not touch. List under
     ⚠ Needs attention with the `html_url` and the recommendation "dismiss as
     *No fix available* or accept until upstream patches" — you cannot dismiss
     alerts (read-only token); the human does that.
  c. Package is in the deferral list as a *direct* dep → DEFER, but still
     report it under ⚠ with the CVE.

### Mobile patch bumps

  - `npm outdated` entries where `current ≠ wanted` AND `wanted` is within the
    existing caret range → AUTO-FIX (lockfile-only).
  - Expo SDK same-major patch bumps (`55.0.X → 55.0.Y`) → AUTO-FIX.
  - Anything matching the deferral list, any major, or when unsure → DEFER.

## Step 3 — Apply AUTO-FIX (one PR per side)

If `DRY_RUN=true`: do everything up to the commit, then `git checkout -- .`
and stop — open no PRs, post no comments. The planned diff and would-be PR body
go into the step summary (Step 7) instead.

For each side with ≥1 auto-fix item:
  1. `git checkout -b claude/auto-deps-<side>-YYYY-MM-DD`
  2. Apply all items for that side in one branch:
       overrides: edit `<side>/package.json` `overrides`, then `npm install`
       caret patches: `npm update <pkg>` (transitive) or `npm install <pkg>@<wanted>` (direct)
     Never add a transitive as a new direct dependency.
  3. Quality gates:
       backend: npm run type-check && npm test
       mobile : npm run type-check && npm test && npx expo export --platform ios --output-dir "$RUNNER_TEMP/expo-export"
       web    : npm run lint && npm run build
     Plus for every side: `npm ci --dry-run` must succeed (lockfile in sync).
  4. DIFF GUARD — `git diff --name-only` must contain ONLY
     `<side>/package.json` and/or `<side>/package-lock.json`.
     Anything else → abort the whole batch → ⚠ Needs attention.
  5. Any gate fails → abort the whole batch → ⚠ Needs attention.
  6. `git commit` with a conventional message containing a version table and
     GHSA refs; end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
  7. `git push -u origin <branch>`
  8. `gh pr create --base main --title "chore(deps): <what> (<side>, YYYY-MM-DD)" --body "<table, GHSA refs, gate results, link to RUN_URL>"`
  9. `gh pr merge --auto --squash --delete-branch <url>`

## Step 4 — Deferred tracking issue

Find the open issue titled exactly **Deferred dependency upgrades**. Create it
if missing (label `automation`); otherwise REPLACE its body. Body: bullet list
of every DEFER item with `current → latest`, the unblock condition, and any
open moderate/low alerts with no action planned. Include "Last refreshed:
YYYY-MM-DD". Skip when `DRY_RUN=true`.

## Step 5 — Expo SDK divergence (informational)

  cd mobile && npx expo install --check 2>&1

Report "should be updated" lines under 📐. Do NOT act on them. If the command
fails for network reasons, say so in one line and move on.

## Step 6 — Daily log comment

Find the open issue titled exactly **Daily upgrade scan log**; create it if
missing (label `automation`). Post ONE new comment. Skip when `DRY_RUN=true`.

  ## YYYY-MM-DD scan — 🟢{X} 🟡{Y} ⏸{Z} ⚠{W}

  🟢 Auto-merging — N
    - <pkg> (X.Y → A.B) [GHSA-…]: #<PR>

  🛡 Dependabot alerts — N open (H high / M moderate / L low)
    - fixed this run: …
    - no upstream fix (needs human dismiss): <pkg> — <html_url>
    - owned by open Dependabot PR: #…

  ⚠ Needs attention — N
    - <pkg>: <failure reason>

  📐 Expo SDK divergence — N (informational)

  ⏸ Deferred — N (see <link to deferred tracking issue>)

  ✅ All clean — only if every bucket above is empty

  _Run: <RUN_URL>_

If you hit a fatal error, still post the comment with a
"## YYYY-MM-DD scan — ⚠ ROUTINE ERROR" heading, the error, and partial state.

## Step 7 — Step summary (ALWAYS, dry run or not)

The action hides your conversation from the job log, so the job summary is the
only place a human can see what you decided without opening GitHub issues.
As your final action, append the full daily-log comment body (Step 6) to the
file named by `$GITHUB_STEP_SUMMARY` — in a dry run, append what you *would*
have posted, prefixed with `## DRY RUN — nothing was posted`, followed by a
fenced block containing `git diff` for each side you would have changed.
Write it with a heredoc (`cat >> "$GITHUB_STEP_SUMMARY" <<'EOF' ... EOF`).
Do this even after a fatal error.

## Hard constraints

  - Never push to `main`.
  - Never modify any file outside `<side>/package.json` / `<side>/package-lock.json`
    (diff guard). In particular never edit this prompt, workflows, or `.github/dependabot.yml`.
  - Never disable lint, tests, coverage thresholds, or the diff guard.
  - Never use `--no-verify`.
  - Never enable auto-merge on anything outside the AUTO-FIX bucket.
  - Never bump anything in the deferral list.
  - Never open a PR that duplicates an open Dependabot PR.
  - Time budget ~30 min. Priority: security overrides > mobile patches >
    tracking issue > daily log > step summary (never skip the summary).
