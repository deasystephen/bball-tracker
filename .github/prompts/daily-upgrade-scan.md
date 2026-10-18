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
3. **Deferral-list upkeep** (including the report-only inventory of backend
   and web majors, which Dependabot ignores) and the **daily log**.

## Inline deferral list (authoritative)

NEVER bump these. Surface them in the deferred tracking issue + daily log only.

  Backend:
    - jest, @types/jest          (waiting for v30 perf regression fix)
    - prisma-client generator    (migration from prisma-client-js; needs import path changes)

  Mobile (RN ecosystem — pinned by the Expo SDK, currently SDK 57 / RN 0.86;
  defer all until the next Expo SDK upgrade):
    - react-native, @react-native-async-storage/async-storage
    - @react-native-community/datetimepicker
    - react-native-gesture-handler, react-native-reanimated
    - react-native-safe-area-context, react-native-screens
    - react-native-svg, react-native-worklets
    - jest, @types/jest

  Mobile (binary-coupled — defer until the next native build, #562):
    - EVERY package listed in `mobile/binary-manifest.json` under the runtime
      that matches `version` in `mobile/app.config.js`. That file is the list;
      read it, do not work from memory. It holds every package with native
      code (all `expo-*` modules, `expo` itself, `@sentry/react-native`,
      `@amplitude/analytics-react-native`, `react-native-*`, …) and `react`.
    - react-test-renderer (it must equal the `react` version).
    Why: an OTA ships JavaScript from the lockfile and runs it against the
    native code frozen in the binary. Bumping one of these on `main` makes the
    next OTA deliver JavaScript no binary has ever run. This applies to
    lockfile-only and transitive bumps too, and to security overrides: if the
    fix for an alert would change the resolved version of one of these
    packages, do NOT apply it — report it under ⚠ with the note
    "needs a native build" and list it in the deferred tracking issue.

## Step 1 — Inventory

  - cat "$ALERTS_JSON"            (open alerts: severity, package, manifest,
                                   vulnerable_range, first_patched, html_url)
  - cd mobile && npm ci && npm outdated --json
  - cd backend && npm ci && npm outdated --json
  - cd web && npm ci && npm outdated --json
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
     A bare root `"<pkg>"` entry is allowed ONLY when `npm ls <pkg> --all`
     shows a single major line. If it shows more than one major (vulnerable or
     not — e.g. minimatch 3.x beside 10.x, js-yaml 3.x beside 4.x), key the
     override by the vulnerable major: `"<pkg>@^<major>": "^<first_patched>"`
     at the root, or inside the parent that pulls it in
     (`"<parent>": { "<pkg>@^<major>": "^x.y.z" }`). Never use a bare
     `"<parent>": { "<pkg>": … }` either: it covers the parent's whole subtree
     and every future major of the parent. Never force a major jump (up or
     down) on any consumer; the gate in Step 3 checks this. Rules and worked
     examples: `docs/automation/daily-upgrade-scan.md`, "Override shape".
     Exception: if the patched version's major differs from every installed
     copy AND the parent's peer range forbids it → ⚠ Needs attention.
  b. `first_patched` is null → **no upstream fix**. Do not touch. List under
     ⚠ Needs attention with the `html_url` and the recommendation "dismiss with
     reason *Risk is tolerable to this project* (GitHub has no 'no fix
     available' reason) or accept until upstream patches" — you cannot dismiss
     alerts (read-only token); the human does that.
  c. Package is in the deferral list as a *direct* dep → DEFER, but still
     report it under ⚠ with the CVE.

### Retire dead overrides (all sides)

For every side (`backend/`, `web/`, `mobile/`), run from that side's directory:

    node ../.github/scripts/check-override-ranges.mjs --overrides

It reads the LOCKFILE, never the installed tree (`npm ci` on this Linux runner
skips `os`/`cpu`-gated optional packages such as sharp's `@img/*`, which would
otherwise look absent), and needs no prior `npm install` (it falls back to
npm's own `semver`). It prints one `live` or `DEAD` line per
`package.json#overrides` key, nested blocks included. A key is live when some
lockfile entry still DECLARES the package (regular, optional or peer
dependency, or an `npm:` alias of it) with a spec that intersects the key's
range; inside a nested `"<parent>": { … }` block only the parent copies and
their dependency graph count. Keys listed in
`.github/scripts/accepted-overrides.json` print `live (accepted …)` whatever
the tree says and are never retired; their reasons are in
`docs/automation/daily-upgrade-scan.md`, "Accepted cross-major overrides".
The script never looks at resolved versions, and neither may you: a
version-keyed override that redirects out of its own range (`deepmerge-ts@^7`
→ 8.0.2) makes `npm ls "<pkg>@<range>"` print `(empty)` precisely because it
works. Do not substitute an `npm ls` probe for any key shape. When every child
of a nested block is `DEAD`, remove the block.

A dead entry would silently pin any future consumer of that package. Removing
it → AUTO-FIX for that side (refresh the lockfile with `npm install` in the same
branch, Step 3). Remove nothing the probe reports `live`, even a copy that
already satisfies the floor; that is a human call. Name each removed entry in
the PR body and on the 🟢 line of the daily log ("override retired: <entry>").

### Mobile patch bumps

  - `npm outdated` entries where `current ≠ wanted` AND `wanted` is within the
    existing caret range → AUTO-FIX (lockfile-only).
  - Anything in the binary-coupled deferral list → DEFER, even a patch. This
    includes Expo SDK same-major patch bumps (`55.0.X → 55.0.Y`), which were
    auto-fixed before #562: almost every Expo module has native code.
  - Anything matching the deferral list, any major, or when unsure → DEFER.
  - After `npm update` / `npm install`, run `npm run binary-manifest:check` in
    `mobile/` BEFORE the other gates. If it fails, a binary-coupled package
    moved (often as a transitive of something you did mean to bump): revert
    that item and DEFER it. Never edit `mobile/binary-manifest.json` and never
    run `binary-manifest:record`; only a human records a verified build.

### Backend / web majors (report only)

  - From the `backend/` and `web/` `npm outdated --json` output: every entry
    whose `latest` major differs from its `current` major → DEFER. Skip an
    entry whose `latest` is a prerelease (e.g. `prisma 8.0.0-rc.*`).
  - Never bump one and never open a PR for one: Dependabot owns patch/minor
    on both sides and ignores majors; the human owns majors. Your job is to
    make them visible on the deferred tracking issue (Step 4) so they are
    triaged before an advisory forces the jump.
  - Patch/minor entries on backend and web are Dependabot's lane: do not list
    them, do not act on them.

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
       mobile : npm run binary-manifest:check && npm run type-check && npm test && npx expo export --platform ios --output-dir "$RUNNER_TEMP/expo-export"
       web    : npm run lint && npm run build
     Plus for every side: `npm ci --dry-run` must succeed (lockfile in sync).
     Plus for every package you added or changed an override for, from `<side>/`:
       node ../.github/scripts/check-override-ranges.mjs <pkg> [<pkg> ...]
     It must exit 0 (no consumer resolved into a different major from the
     range it declares; `npm ls` cannot show this, an override hides it). A
     mismatch listed in `.github/scripts/accepted-overrides.json` prints as
     `accepted` and does not count; never edit that file from a scan run. Put
     the output and `npm ls <pkg> --all` in the PR body.
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
open moderate/low alerts with no action planned. It MUST contain a section
headed **`## Backend / Web — majors (human-owned)`** listing every package
from "Backend / web majors (report only)" as `<pkg> current → latest`, grouped
by side, with a one-line unblock note where one is known (the inline list's
jest and prisma-generator entries keep their notes). Do not attribute these
sides to Dependabot, which ignores majors on both.

It MUST also contain a section headed **`## Infra — Terraform provider and
Docker images (human-owned)`** (report only; never edit anything under
`infra/`, `docker/` or `docker-compose.yml`):
  - `hashicorp/aws <locked> → <latest>`: `<locked>` is the `version` in
    `infra/.terraform.lock.hcl`; `<latest>` is
    `curl -s https://registry.terraform.io/v1/providers/hashicorp/aws | jq -r .version`
    (write "registry unreachable" if the call fails). When the majors differ,
    note that Dependabot ignores `hashicorp/aws` majors and that a provider
    major is a human migration (5 → 6 was PR #913): cite the open issue for it
    if one exists (search `gh issue list --search "hashicorp/aws"`), otherwise
    say that none is filed yet.
  - every open Dependabot PR labelled `infra`
    (`gh pr list --author app/dependabot --label infra --state open`) as
    `#<n> <title>`: these wait for a human `terraform plan` or image review.
  - "nothing deferred" when both lists are empty.

Include "Last refreshed: YYYY-MM-DD". Skip when `DRY_RUN=true`.

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
As your final action, write the full daily-log comment body (Step 6) to
`$SCAN_REPORT` (path provided in the prompt context) — in a dry run, write what
you *would* have posted, prefixed with `## DRY RUN — nothing was posted`,
followed by a fenced block containing `git diff` for each side you would have
changed. Use a heredoc (`cat > "$SCAN_REPORT" <<'EOF' ... EOF`). The workflow
appends that file to the job summary and uploads it as an artifact. Do this
even after a fatal error.

## Hard constraints

  - Never push to `main`.
  - Never modify any file outside `<side>/package.json` / `<side>/package-lock.json`
    (diff guard). In particular never edit this prompt, workflows, or `.github/dependabot.yml`.
  - Never disable lint, tests, coverage thresholds, or the diff guard.
  - Never use `--no-verify`.
  - Never enable auto-merge on anything outside the AUTO-FIX bucket.
  - Never bump anything in the deferral list.
  - Never bump, and never open a PR for, a backend or web major: report it
    on the deferred tracking issue only.
  - Never open a PR that duplicates an open Dependabot PR.
  - Time budget ~30 min. Priority: security overrides > mobile patches >
    tracking issue > daily log > step summary (never skip the summary).
