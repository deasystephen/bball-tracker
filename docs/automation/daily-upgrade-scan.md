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
| **Dependabot (infra)** | Version PRs for the `terraform` ecosystem (`/infra`: the AWS provider in `infra/.terraform.lock.hcl`, committed since #786; `hashicorp/aws` majors ignored; 5 → 6 landed 2026-10-18 (#866), the next major is a human step again), `docker` (`/docker`: the Dockerfile's `node:22-alpine`) and `docker-compose` (`/`: the dev Postgres and Redis images in `docker-compose.yml`). **Never auto-merged**: `dependabot-auto-merge.yml` recognises the three ecosystems and leaves them at `auto-merge=false` | `.github/dependabot.yml`, labels `infra` + `dependencies`. A human reviews each one. For a terraform bump the reviewer runs `terraform init` and `terraform plan` from `infra/` with production credentials and merges only on "No changes.": CI runs `fmt`/`init`/`validate` (so a bumped lock is installable and validated) but never `plan` or `apply`. A local `init` may rewrite the lock (hashes for another platform); do not commit that from the review. A lock-only merge does not deploy (the `ci.yml` deploy filter and `.github/scripts/deploy-contents.sh` exclude `infra/.terraform.lock.hcl`); if a merge still deploys, check for `IN_PROGRESS` games first. A Node or Postgres major also moves the files the config-bound tests pin (`backend/tests/infra/node-version.test.ts`, `postgres-version.test.ts`), so that PR is red until a human widens it |
| **Claude scan** | Security `overrides` for vulnerable transitives (all sides), and retiring any override whose target has left the tree ("Override shape" below); **mobile** caret patch bumps (Dependabot's regenerated mobile lockfile drops `overrides` and fails `npm ci` — see #290/#300); deferral list, which **inventories backend/web majors into #275 (report only)**, since Dependabot ignores `semver-major` on both sides; daily log | `daily-upgrade-scan.yml` |
| **Human** | Majors, mobile minors (RN peer deps), **Terraform provider and Docker image bumps** (see "Dependabot (infra)"), **GitHub Actions bumps** (deliberately outside the auto-merge policy — a workflow bump can change what CI itself does), Expo SDK upgrades, **any mobile package with native code and the `react` family** (they move only with a native build, see "Binary-coupled packages" below), dismissing alerts with no upstream fix | — |

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
| **Auto-fix** | High/critical alert **with** a `first_patched` version → `overrides` entry, root or version-keyed per "Override shape" below (even when `npm audit` says the fix path is a major bump of the parent); mobile caret-range patch bumps of **JavaScript-only** packages | Branch + gates + diff guard + PR + `gh pr merge --auto --squash` |
| **Needs attention** | Alert with **no** upstream fix (e.g. `image-size` ≤2.0.2 inside Metro); a gate or the diff guard failed; snapshot missing | Reported in the log with a link; human dismisses (reason: *Risk is tolerable to this project* — GitHub offers no "no fix" reason) or decides |
| **Defer** | Inline deferral list in the prompt (Jest 30, RN ecosystem, prisma generator), any major, **every binary-coupled mobile package, Expo SDK same-major patches included** | Rolling **Deferred dependency upgrades** issue (#275), body replaced daily |

## Override shape (#779)

A bare root entry (`"minimatch": "^3.1.3"`) applies to **every** consumer in the tree, including
ones that declare a newer major. npm then hides the mismatch: `npm ls` prints `overridden`, never
`invalid`, and the only symptom is a runtime `TypeError` when a consumer calls an export the old
major lacks. Until #779 the backend forced ESLint 10, `@eslint/config-array` 0.23 and
typescript-estree (all `minimatch ^10`) onto 3.1.5, and mobile forced `@expo/fingerprint` and every
`glob@10`/`glob@13` onto 5.1.9. The rules the scan follows (`.github/prompts/daily-upgrade-scan.md`,
Step 2a and the Step 3 gate):

- **A bare root `"<pkg>"` entry only when `npm ls <pkg> --all` shows one major line.** Otherwise key
  the override by the vulnerable major: `"<pkg>@^<major>": "^<patched>"`, at the root or inside the
  parent that pulls the copy in.
- **No bare parent rule (`"<parent>": { "<pkg>": … }`).** It covers the parent's whole subtree and
  every future major of the parent, so it pins consumers that ask for something else. ESLint shows
  why: mobile's ESLint 9 declares `minimatch ^3.1.5`, but backend's `eslint@10` and
  `@eslint/config-array@0.23` declare `^10`. A bare `"eslint"` rule written for one would break
  the other, or break mobile at its next ESLint major. Jest 30 does the same through
  `test-exclude@7` → `glob@10` → `minimatch ^9`.
- **How a version key matches.** npm's matcher is `semver.intersects(<declared range>, <key range>)`,
  not a subset test. `"minimatch@^5"` therefore matches every consumer whose range *overlaps* 5.x:
  `5.1.2`, `^5.0.1`, but also `^3 || ^5`, `>=3` or `*`. A floor inside the key's own major
  (`"^5.1.8"`) is safe only because each overlapping range also admits that major. Never key one
  major and point it at another.
- **Don't add inert entries.** If every consumer of the old line already resolves to a patched
  version with no override, there is nothing to add. #779 removed eleven such entries.
- **Retire dead entries.** The scan also removes an override whose target has left the tree, and
  makes the removal an auto-fix item with a refreshed lockfile (prompt, "Retire dead overrides").
  It probes the lockfile, never the installed tree, because `npm ci` on the Linux runner skips
  `os`/`cpu`-gated optional packages (sharp's `@img/*`) and would make a live override look dead:
  and it decides on **declared specs, never resolved versions**:
  `node ../.github/scripts/check-override-ranges.mjs --overrides` prints `live` or `DEAD` per key
  (nested blocks at every depth), live when some lockfile entry still declares the package as a
  regular, optional or installed peer dependency with a spec that intersects the key's range (an
  `npm:` alias is matched under the alias name, never the aliased package, as npm does); inside a
  nested `"<parent>": { … }` block only the parent copies and their dependency graph count (`bin`
  names and uninstalled peers never do). `STALE` and `ORPHAN` lines are for a human, never the scan. The resolved version is the wrong signal because
  an override changes it: `npm ls "<pkg>@<range>"` prints `(empty)` for a working cross-major
  redirect, which is how the scan retired the accepted `deepmerge-ts@^7` entry below (PR #919,
  2026-10-18, deployed unattended, GHSA-ggr8-5vv4-36mx reopened; PR #923 restored it and replaced
  the `npm ls` probes with the script). Keys listed in `.github/scripts/accepted-overrides.json`
  are reported `live (accepted …)` and never retired. #777 retired the backend's `hono`,
  `@hono/node-server` and `fast-xml-builder` entries.
- **Gate:** after `npm install`, run `node ../.github/scripts/check-override-ranges.mjs <pkg> …`
  from the package directory. It exits non-zero when any consumer in `package-lock.json` resolves
  into a different major from the range it declares, the case `npm ls` hides. It lists, but
  passes, a same-major floor such as eas-cli's exact `5.1.2` raised to 5.1.9. Also compare the old
  and new lockfiles: an override change should not move unrelated versions.

Current minimatch overrides: mobile's `"eas-cli": { "minimatch@^5": "^5.1.8" }` floors eas-cli's
exact `5.1.2` pin. It is version-keyed because eas-cli's subtree also holds `glob@10`/`glob@13`,
which need `^9`/`^10`. The `@oclif/core` block keys its floor as `"minimatch@^10": "^10.2.5"`
(`docs/deployment/mobile-builds-and-ota.md`, eas-cli pinning). Until #925 it was a bare
`"minimatch"` child, which also dragged `filelist` (jake, inside @oclif/core's and eas-cli's graph,
declares `^5.0.1`) onto 10.x; `filelist` now resolves to 5.1.9 under the eas-cli key. The
`minimatch@^10` key is inert today (@oclif/core 4.11.4 already declares `^10.2.5`) and is kept on
purpose as the #343 regression guard; being version-keyed, it can never match eas-cli's exact
`5.1.2` edge. The same change re-keyed mobile's root `"ws"` and `"js-yaml"` as `"ws@^8"` and
`"js-yaml@^4"`: the `^7` ws consumers (Metro, the React Native dev middleware,
`react-devtools-core`) and `@istanbuljs/load-nyc-config`'s `js-yaml ^3` had been forced across a
major. Each advisory has a patched release in the older major (ws 7.5.11 for GHSA-96hv-2xvq-fx4p,
js-yaml 3.15.2 for GHSA-2883-xcg3-v3hh) and those consumers resolve to 7.5.13 and 3.15.2 with no
override, so no `@^7`/`@^3` floor was added (inert, see above) and nothing in mobile is accepted
cross-major. It also retired the inert `"@oclif/core": { "js-yaml": "^3.15.2" }` child: its only
declarers, the two nested @oclif/core 2.16.0 copies, declare `^3.14.1` and resolve to 3.15.2
without it. The backend has no minimatch or brace-expansion override: the `^3` consumers resolve to
3.1.5, and brace-expansion 1.1.21 is the newest 1.x release, so the old root floors were inert.

**Accepted cross-major overrides.** The list is `.github/scripts/accepted-overrides.json`, keyed by package directory (`override`, `consumer`, `gets` = the range the override resolves to, `ghsa`, `why` with the retirement condition); the gate script reads it, prints a listed mismatch as `accepted … (GHSA, accepted-overrides.json)` with exit 0, and its `--overrides` mode prints a listed key `live (accepted …)` while something still declares it and `STALE` once nothing does, for a human to retire with the entry. Adding or retiring an entry is a human decision made in a reviewed PR together with the reasoning here; the scan never edits the file. `backend/tests/infra/check-override-ranges.test.ts` pins the file's shape, the script's verdicts on fixtures (with their own accept list through `ACCEPTED_OVERRIDES_FILE`), and one live fact: the real backend lockfile still produces the accepted `deepmerge-ts` line. **That last test goes red on purpose the day a Prisma release declares `deepmerge-ts` 8.x** (a Dependabot or scan PR for that bump fails `Test Backend`); the retire procedure is then one PR that removes the override, its accept entry and that expectation, after which `--overrides` would otherwise have reported the key `STALE`. Today's only entry: the backend's `"deepmerge-ts@^7": "^8.0.2"` redirects `@prisma/config` (which declares the exact pin `7.1.5`, inside the `^7` key) to 8.x on purpose (#890). GHSA-ggr8-5vv4-36mx covers every version below 8.0.0 and its first patch is 8.0.0, so no patched 7.x exists and the override is the security fix. Prisma 7.10.1 itself declares `deepmerge-ts` 8.0.2, which shows the API is compatible. The entry retires when Prisma is bumped deliberately to a release that declares 8.x (7.10.1 also carries 8.1.0 engines, so that is a separate decision).

## Audit floor gate (#924)

`.github/scripts/check-audit-floor.mjs` asserts that no production dependency resolves under a high or critical advisory floor. It runs `npm audit --omit=dev --json` in the current package directory and fails on every advisory of severity `high` or `critical` that `.github/scripts/accepted-advisories.json` does not list for that side. It exists because of #919: the scan removed the backend's `deepmerge-ts@^7` security override, `deepmerge-ts` resolved back to 7.1.5 under GHSA-ggr8-5vv4-36mx, every other gate stayed green, and the PR auto-merged and deployed unattended. Run against that lockfile (`a767dc1`), the gate prints `FAIL GHSA-ggr8-5vv4-36mx deepmerge-ts <8.0.0 (high)` and exits 1.

- **Where it runs.** In `ci.yml` as its own matrix job, `Audit floor (backend)`, `Audit floor (mobile)` and `Audit floor (web)`, on every pull request (Dependabot's and the scan's included) and every push to `main`. A new advisory or a registry hiccup fails one attributable check and leaves the test jobs' results readable. The job installs nothing: `npm audit` reads the lockfile, and `semver` comes from npm's bundled copy. Every `npm ci` in `ci.yml` passes `--no-audit --no-fund`, so a run calls the audit endpoint once per package, in this job. **The three checks gate an auto-merge only once they are required status checks of `main`** (the owner adds them in branch protection, as for the web jobs in #690); until then a Dependabot pull request with a red audit can still merge, and only the deploy is held. In the scan, Step 3 runs it for every side before the PR is opened; a failure aborts the batch to Needs attention.
- **It sits in the deploy path.** `Build & Deploy to ECS` needs the `audit-floor` job, so a newly published high or critical advisory against a production dependency blocks every deploy of `main`, a hotfix included, until an override or an allow-list entry lands. For a hotfix, add that override or entry in the same pull request as the fix; do not wait for a separate one.
- **Output.** One line per high or critical advisory and package: `FAIL <GHSA> <package> <range> (<severity>): <title> <url>`, `FAIL <GHSA> <package>: a patched version exists …` when npm reports a reachable fix for an accepted advisory (`fixAvailable` is `true`, or a parent change that is not semver-major; npm's semver-major suggestions are ignored because it makes them even when no patch exists, such as a downgrade to expo-updates 0.11.7 for node-forge), `FAIL <GHSA> <package>: the advisory moved …` when an accepted advisory's reported range is no longer the same version set as the entry's `range` (compared with `semver.subset` both ways, so re-formatting such as `<=3.0.3` vs `<= 3.0.3` is not a move; re-review the entry), `FAIL <GHSA> <package>: the advisory was re-scored …` when its severity differs from the entry's `severity` (a `high` re-scored `critical`; re-review), or `accepted <GHSA> … (.github/scripts/accepted-advisories.json)`. The patched-version and moved-range FAILs are the retire signals: apply the patch and remove the entry. An entry the audit no longer reports for its package, or now reports below `high`, prints `stale …` (saying which) without failing, so a human can retire it; a `package` typo shows up this way too, next to the advisory's `FAIL`. The id is the GHSA id found anywhere in the advisory URL; an advisory without one (a legacy npmjs.com URL, or none) is keyed `npm-<source id>`, and its `FAIL` line names the id an entry must use. A repeated (`ghsa`, `package`) entry, or an allow-list that is not a JSON object keyed by side, stops the gate with exit 2. Exit 0 clean, 1 on any `FAIL`, 2 when the gate could not run (registry unreachable, npm missing, an unreadable allow-list): it fails closed, printing npm's own message; a registry outage turns the job red, and re-running the job is the remedy.
- **Scope.** Production dependencies only (`--omit=dev`), at `high` and above. On 2026-10-18 the production trees of `backend/` and `web/` reported no advisory at all, and `mobile/` reported two high ones with no patched release (below). The full trees, dev dependencies included, also report the unpatchable `braces` advisory through Jest and `eslint-config-next`; they are not gated. Moderate advisories (`sprintf-js`, `decode-uri-component`, `uuid` among them) are not gated either.
- **When it goes red on an advisory you did not cause.** A new advisory against something already in the tree turns every pull request red until it is handled. The fix is the same as the scan's auto-fix bucket: an `overrides` entry that lifts the package above the advisory's first patched version ("Override shape" above), in its own pull request.
- **Adding an allow-listed advisory.** Only when the advisory has **no patched version** (or the patched version cannot be reached without a binary or major the project has deferred). A human adds an entry under the side's key in `.github/scripts/accepted-advisories.json` with `ghsa` (the id the gate's `FAIL` line prints: a GHSA id, or `npm-<source id>`), `package` (the entry matches on both), `range` and `severity` (as `npm audit` prints them today; the pins that make a moved or re-scored advisory fail), `why` (why no override can fix it and why the exposure is tolerable) and `revisit` (the condition that retires it), in a reviewed pull request; dismiss the matching GitHub alert at the same time. The scan never edits the file. `backend/tests/infra/check-audit-floor.test.ts` pins the file's shape and the script's verdicts on fixture reports, and runs the production path against a fake `npm` on `PATH` (no network). Both accept lists, and `semver`, are loaded through `.github/scripts/accept-list.mjs`.
- **Today's entries (mobile only).** `GHSA-vfj7-8cjw-p6xm` (`braces` ≤ 3.0.3, stack-exhaustion DoS; through `micromatch` on two build and test tooling paths: Metro's `metro-file-map`, and react-native's optional peer `@react-native/jest-preset` → `babel-jest` → `@jest/transform`, which is why npm suggests `jest` 30.5.2) and `GHSA-86w9-cpqp-85rv` (`node-forge` ≤ 1.4.0, RSA signature verification; through `@expo/code-signing-certificates`, and EAS Update code signing is not configured). Neither advisory names a patched version; both GitHub alerts were dismissed on 2026-10-18. Each retires when its package publishes a patched release.

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
