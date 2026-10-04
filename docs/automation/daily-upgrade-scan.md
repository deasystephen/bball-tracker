# Daily Upgrade Scan

A scheduled GitHub Actions workflow (`.github/workflows/daily-upgrade-scan.yml`)
that runs Claude Code once a day to triage security alerts and dependency
updates, open PRs for safe changes (auto-merge on the narrowest bucket), keep
the deferral list current, and post a daily summary comment on the rolling
**Daily upgrade scan log** issue (#276).

> **History.** From 2026-04 to 2026-08 this ran as an Anthropic-hosted Claude
> Code routine (`trig_01JNQaGi6W2wGKdKA961kUYT`). That sandbox could never call
> the Dependabot alerts API (no `gh` on most runs; raw `api.github.com` blocked
> by the egress proxy), so it fell back to `npm audit` and over-deferred
> override-fixable transitives. Moved to GitHub Actions in PR #335 so the job
> runs where `gh`, `GITHUB_TOKEN`, and a scoped PAT all work. The hosted
> routine was retired on 2026-08-24 — paused after three green scheduled
> Actions runs (Aug 21–23), then deleted from claude.ai/code/routines; the
> Actions workflow is now the only scanner.

## Schedule

- **Cron**: `0 15 * * *` (15:00 UTC; 08:00 PT summer / 07:00 PT winter). GitHub
  may start scheduled runs up to ~30 min late under load.
- **Manual**: Actions → *Daily Upgrade Scan* → *Run workflow*. Tick **dry_run**
  to inventory + categorize without opening PRs or posting comments.

## Division of labour

| Who | Owns | Mechanism |
| --- | --- | --- |
| **Dependabot** | Version bumps: backend/web patch+minor, mobile patch | `.github/dependabot.yml` (weekly groups) + `.github/workflows/dependabot-auto-merge.yml` flips auto-merge; branch protection still gates on CI. The web CI jobs (`Lint and Type Check (web)`, `Test Web`; #690) run on `/web` bumps but gate auto-merge only once the owner adds both to the required status checks of `main`; until then a red web job does not stop a `/web` merge |
| **Claude scan** | Security `overrides` for vulnerable transitives (all sides); **mobile** caret patch bumps (Dependabot's regenerated mobile lockfile drops `overrides` and fails `npm ci` — see #290/#300); deferral list, which **inventories backend/web majors into #275 (report only)**, since Dependabot ignores `semver-major` on both sides; daily log | `daily-upgrade-scan.yml` |
| **Human** | Majors, mobile minors (RN peer deps), **GitHub Actions bumps** (deliberately outside the auto-merge policy — a workflow bump can change what CI itself does), Expo SDK upgrades, **any mobile package with native code and the `react` family** (they move only with a native build, see "Binary-coupled packages" below), dismissing alerts with no upstream fix | — |

The Claude prompt lives at **`.github/prompts/daily-upgrade-scan.md`** and is
the single runtime source of truth — the workflow tells Claude to read that
file. There is no second copy to keep in sync.

## What reaches production, and when (#570)

The two automations merge the same way and deploy differently.

| | Auto-merge enabled by | After the merge |
| --- | --- | --- |
| **Dependabot** | `GITHUB_TOKEN` (`dependabot-auto-merge.yml`) | No `CI` run starts on `main`, so nothing is deployed. A backend bump waits on `main` and ships with the next deploy |
| **Claude scan** | the Claude GitHub App's token | `CI` runs on `main`. A pull request that touches `backend/` **deploys to production unattended**, usually between 15:00 and 19:00 UTC. It also carries any Dependabot bump that was waiting |

Web and mobile pull requests deploy nothing in either case: the web app is not deployed from CI
and mobile ships by OTA, which has its own guard (#562).

So a security `override` for the backend is in production the same day, and a Dependabot
backend bump is not in production until somebody deploys. To ship waiting bumps on purpose, start
the `CI` workflow by hand on `main`. Every deploy lists what it carries in its run summary. The
commands are in `docs/deployment/aws-setup.md`, "What a deploy carries".

Dependabot's behaviour is kept on purpose. Enabling its auto-merge with a token that starts
workflows would roll production on every Monday's bumps and on security updates on any day, and
each rollout briefly splits live games.

## Buckets

| Bucket | Examples | Action |
| --- | --- | --- |
| **Auto-fix** | High/critical alert **with** a `first_patched` version → root `overrides` entry (even when `npm audit` says the fix path is a major bump of the parent); mobile caret-range patch bumps of **JavaScript-only** packages | Branch + gates + diff guard + PR + `gh pr merge --auto --squash` |
| **Needs attention** | Alert with **no** upstream fix (e.g. `image-size` ≤2.0.2 inside Metro); a gate or the diff guard failed; snapshot missing | Reported in the log with a link; human dismisses (reason: *Risk is tolerable to this project* — GitHub offers no "no fix" reason) or decides |
| **Defer** | Inline deferral list in the prompt (Jest 30, RN ecosystem, lottie ≥7.4, prisma generator), any major, **every binary-coupled mobile package, Expo SDK same-major patches included** | Rolling **Deferred dependency upgrades** issue (#275), body replaced daily |

## Binary-coupled packages (#562)

An OTA (`eas update`) ships JavaScript from `mobile/package-lock.json` and runs
it against the native code that was compiled into the binary. A package that
has native code therefore has two halves that must match, and only a native
build moves the native half. Between 2026-09-07 and 2026-09-27 this scan moved
four such packages on `main` (Amplitude, Sentry, `expo-updates` and the
`react` family) in ordinary patch-bump PRs. Every gate passed, because none of
them can see the problem: Jest renders with `react-test-renderer`, and
`expo export` only proves that the bundle builds. The next OTA would have
been the first time that JavaScript ran on a real binary.

The rule now:

- **Packages with native code, and `react`, move only with a native build and
  a new OTA runtime** (a `version` bump in `mobile/app.config.js`).
- **`mobile/binary-manifest.json` is the list.** It records, per runtime, the
  version of each such package in the newest binary.
- **`mobile/__tests__/binary-manifest.test.ts` enforces it.** It recomputes
  the set from the lockfile and `node_modules` (a package counts when its root
  has an `ios/` or `android/` directory, a `*.podspec` or an
  `expo-module.config.json`) and fails on any changed, added or removed
  package. It is part of `npm test`, so a scan PR or a Dependabot PR that
  moves one of them cannot merge.
- **The scan never edits the manifest.** Its diff guard already limits it to
  `package.json` and `package-lock.json`. Recording a build is a human step
  (`npm run binary-manifest:record`), described in
  `docs/deployment/mobile-builds-and-ota.md` under "OTA drift guard (#562)".

What this costs: security fixes in a binary-coupled package wait for a build.
The scan reports them under ⚠ with "needs a native build" so they are visible.

## Secrets and permissions

Both secrets are **Environment secrets** on the `upgrade-scan` environment
(Settings → Environments → `upgrade-scan`), whose deployment-branch rule allows
only `main`. The scan job declares `environment: upgrade-scan`, so a run from
any other branch — including a manual `workflow_dispatch` against a feature
branch — fails at job start with no access to the secrets. Repo-level secrets
would be readable by any workflow on any branch once merged.

| Secret | What | Scope |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token | Generated with `claude setup-token` on a machine logged into the owner's **Claude Max** account; bills the subscription, not Console credits. ~1-year expiry — rotate by re-running `setup-token`. (Console pay-as-you-go alternative: `anthropic_api_key` input + `ANTHROPIC_API_KEY` secret in a spend-capped workspace.) |
| `DEPENDABOT_ALERTS_TOKEN` | Fine-grained PAT | **This repo only**, permission *Dependabot alerts: Read-only* (and Metadata, implied), ≤90-day expiry. The default `GITHUB_TOKEN` has no dependabot-alerts scope, so a PAT is unavoidable. Exposed to **one** `gh api` step that writes a JSON snapshot to `$RUNNER_TEMP`; Claude's step never receives it and cannot dismiss alerts |

GitHub writes (branches, PRs, comments) go through the **Claude GitHub App**
already installed on the repo — the action exchanges the job's OIDC token for a
short-lived App token. This is deliberate: PRs pushed with `GITHUB_TOKEN` do not
trigger the CI workflow, so auto-merge would wait forever on required checks.
Workflow `permissions:` are the minimum the action needs (`contents`,
`pull-requests`, `issues`: write; `id-token`: write). Like every workflow, it
pins third-party actions to commit SHAs (rule and guard test:
`docs/deployment/ecs-deploys.md`, "CI jobs, Node version and action pins"), and
it sets up Node from the root `.nvmrc`, the production image's major.

## Prerequisites (all in place unless noted)

1. ✅ Repo settings: `allow_auto_merge`, `delete_branch_on_merge`.
2. ✅ Branch protection on `main` requiring CI checks — required for
   `gh pr merge --auto` to mean anything.
3. ✅ Claude GitHub App installed with contents / issues / pull-requests write.
4. ✅ Repo Watch with Issues notifications + "Include your own updates".
5. ✅ `upgrade-scan` Environment exists with branch rule `main` (created 2026-08-20 via API).
6. ✅ `CLAUDE_CODE_OAUTH_TOKEN` **environment** secret on `upgrade-scan`
   (in place — scheduled runs green since 2026-08-21).
7. ✅ `DEPENDABOT_ALERTS_TOKEN` **environment** secret on `upgrade-scan`
   (in place — the alerts snapshot step works; keep a calendar reminder for
   the ≤90-day PAT expiry).
8. ✅ Hosted routine (`trig_01JNQaGi6W2wGKdKA961kUYT`) retired 2026-08-24 —
   paused after verifying three green scheduled Actions runs (Aug 21–23) and
   duplicate daily log comments on #276, then deleted in the claude.ai UI.

## Updating the deferral list

Edit the "Inline deferral list" in `.github/prompts/daily-upgrade-scan.md` and,
if Dependabot should also stop proposing it, add a matching `ignore` in
`.github/dependabot.yml`. Same PR.

Binary-coupled mobile packages are not maintained by hand in that list: the
prompt points at `mobile/binary-manifest.json`, which is regenerated whenever a
build is recorded. A new native module therefore joins the deferral set with
the build that first contains it.

Backend and web majors are not maintained by hand either: the scan runs
`npm outdated` in `backend/` and `web/` and lists every major (prerelease
`latest` excluded) under "Backend / Web — majors (human-owned)" in #275, with
`current → latest`. An inline entry is needed only when a major carries an
unblock condition worth recording (as Jest 30 and the Prisma generator do).

## Disabling

Actions → *Daily Upgrade Scan* → ⋯ → *Disable workflow*. In-flight PRs keep
their auto-merge setting.
