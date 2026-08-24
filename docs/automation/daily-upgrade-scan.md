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
> routine was paused (`enabled: false`) on 2026-08-24 after three green
> scheduled Actions runs (Aug 21–23); the Actions workflow is now the only
> scanner.

## Schedule

- **Cron**: `0 15 * * *` (15:00 UTC; 08:00 PT summer / 07:00 PT winter). GitHub
  may start scheduled runs up to ~30 min late under load.
- **Manual**: Actions → *Daily Upgrade Scan* → *Run workflow*. Tick **dry_run**
  to inventory + categorize without opening PRs or posting comments.

## Division of labour

| Who | Owns | Mechanism |
| --- | --- | --- |
| **Dependabot** | Version bumps: backend/web patch+minor, mobile patch | `.github/dependabot.yml` (weekly groups) + `.github/workflows/dependabot-auto-merge.yml` flips auto-merge; branch protection still gates on CI |
| **Claude scan** | Security `overrides` for vulnerable transitives (all sides); **mobile** caret patch bumps (Dependabot's regenerated mobile lockfile drops `overrides` and fails `npm ci` — see #290/#300); deferral list; daily log | `daily-upgrade-scan.yml` |
| **Human** | Majors, mobile minors (RN peer deps), Expo SDK upgrades, dismissing alerts with no upstream fix | — |

The Claude prompt lives at **`.github/prompts/daily-upgrade-scan.md`** and is
the single runtime source of truth — the workflow tells Claude to read that
file. There is no second copy to keep in sync.

## Buckets

| Bucket | Examples | Action |
| --- | --- | --- |
| **Auto-fix** | High/critical alert **with** a `first_patched` version → root `overrides` entry (even when `npm audit` says the fix path is a major bump of the parent); mobile caret-range patch bumps; Expo SDK same-major patches | Branch + gates + diff guard + PR + `gh pr merge --auto --squash` |
| **Needs attention** | Alert with **no** upstream fix (e.g. `image-size` ≤2.0.2 inside Metro); a gate or the diff guard failed; snapshot missing | Reported in the log with a link; human dismisses (reason: *Risk is tolerable to this project* — GitHub offers no "no fix" reason) or decides |
| **Defer** | Inline deferral list in the prompt (Jest 30, RN ecosystem, lottie ≥7.4, prisma generator), any major | Rolling **Deferred dependency upgrades** issue (#275), body replaced daily |

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
`pull-requests`, `issues`: write; `id-token`: write). Both third-party actions
are pinned to commit SHAs.

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
8. ✅ Hosted routine paused 2026-08-24 (`enabled: false` on
   `trig_01JNQaGi6W2wGKdKA961kUYT`) after verifying three green scheduled
   Actions runs (Aug 21–23) and duplicate daily log comments on #276.

## Updating the deferral list

Edit the "Inline deferral list" in `.github/prompts/daily-upgrade-scan.md` and,
if Dependabot should also stop proposing it, add a matching `ignore` in
`.github/dependabot.yml`. Same PR.

## Disabling

Actions → *Daily Upgrade Scan* → ⋯ → *Disable workflow*. In-flight PRs keep
their auto-merge setting.
