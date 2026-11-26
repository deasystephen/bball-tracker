# Claude Code sessions: stopping rules and reports

How a Claude Code session is expected to behave in this repo. `CLAUDE.md` carries the
one-line rules; this file holds the reasoning and the setup. The rules follow Anthropic's
Opus 5.5 playbook (claude.dev, "Getting the most out of Opus 5.5", September 2026), adapted
to this repo's deploy and shared-checkout constraints.

## When to keep going and when to stop

Opus-class models keep working on a long task on their own and otherwise tend to stop with
a summary that names the next step, or an offer to continue. `CLAUDE.md` names the stops we
want so the model neither stalls on routine steps nor runs through a step that is hard to
undo.

**Keep going** when a step needs no input: tests, lint, type-checks, docs updates, commits on
a branch, pushing a branch, opening a PR, re-seeding the local database before a Maestro
flow, reading production state (`/health`, Datadog, CloudWatch, `aws … describe-*`) and the
production OTA that follows a merged mobile JavaScript change (see `CLAUDE.md`, Deploys).

**Stop and ask**, one question per turn, only when the session cannot continue without the
user, or before a mutating step that is hard to undo:

| Stop before | Why |
| --- | --- |
| Merging to `main` | A merge that touches `backend/`, `infra/`, `docker/` or `ci.yml` deploys to ECS and briefly splits live games; the user also reviews every PR before it lands |
| `terraform apply` | Changes production infrastructure; CI never applies it |
| `eas build`, `eas submit` | Burns a build number and ships a binary to TestFlight |
| Force-pushing | Several sessions share this checkout and its branches |
| Deleting production data | Local resets (`npx prisma db seed`, `docker-compose down -v`, `removeTestRows`) are routine; the `db:reset`/`db:fresh` guard already refuses a non-local `DATABASE_URL` |
| Writes to production AWS | Secrets, task restarts, SES identities, S3 objects; reads are fine |
| Anything outside this repo or that changes the machine | Installing or upgrading tools (Maestro, Xcode, global npm packages), editing files outside the checkout |

An unattended run (the Daily Upgrade Scan in GitHub Actions reads `CLAUDE.md`) has nobody to
ask: it follows its own prompt, which already says what it may merge. Permission prompts for
destructive commands stay on in interactive sessions; the per-project allow list in
`.claude/settings.local.json` (gitignored) must not pre-approve `pkill`, `gh pr merge`,
`eas-cli build/submit/update`, `git push`, `git branch -D` or production AWS writes.

## Rules the harness enforces

A rule that only prose carries holds while somebody is watching. The ones below are refused
before the tool runs, by the PreToolUse hook `.claude/hooks/guard-hard-rules.mjs` (registered
in the committed `.claude/settings.json`, so it applies to every session and every unattended
run in this repo), or fail a required CI check.

| Rule | Hook | CI |
| --- | --- | --- |
| Never `git reset`, `git stash` (other than `list` / `show`), `git checkout -- <path>` or `git checkout .` | denied | |
| Force-push | asks first; an unattended run has nobody to ask, so it is refused | |
| Never `pkill` / `killall` by name | denied | |
| Never `npm start` or `expo start` in `mobile/` | denied | |
| Never build with `CODE_SIGNING_ALLOWED=NO` | denied | |
| Never edit `mobile/binary-manifest.json` by hand | denied (Edit, Write, and a shell redirect, `sed -i`, `tee`, `cp`, `mv`, `rm`) | `mobile/__tests__/binary-manifest.test.ts` |
| Never edit or remove a migration already on `main` | denied (Edit, Write) | `.github/scripts/migration-backfill-guard.sh` (required check) |
| Never add an `eslint-disable` (two named exceptions) | denied (Edit, Write) | `mobile/__tests__/repo/no-lint-suppressions.test.ts`, which scans all three packages |

The hook reads the command the way a shell would: a commit message or a `grep` pattern that
mentions `git stash` passes, while `a && git stash`, `(git stash)`, `bash -c "git stash"` and a
backtick substitution inside a double-quoted string are caught. Its denial names the rule and
what to do instead. It is a guard against a slip, not a sandbox: a script file that runs the
command, or a shell fed through a here-document, is not inspected. If the hook itself fails
(bad input, no `git`), the call is allowed, so a broken guard cannot stop every session.

`mobile/__tests__/repo/claude-hooks.test.ts` runs the hook as a process against a table of
commands that must be denied, asked about and allowed; add a row there with any new rule. Both
tests live in the mobile suite because that job runs on every PR and a change to it does not
start an API deploy.

## Within-run checklist

A long run fills the context window and older turns get summarised. A checklist in a file
survives that. It lives in the session scratchpad directory, never in the repo (a stray
`TASKS.md` would also silence the docs Stop hook, which treats any changed `.md` as "docs
considered") and never in memory: GitHub issues remain the only store for work that outlives
the session. An issue a session files follows `docs/automation/issue-specs.md`.

## Closing message

Lead with what needs the user (a decision left open, a merge to approve), then Changed,
Verified and Wrap-up. Wrap-up is the sweep `CLAUDE.md` asks for: tests, docs, issues the
change closes or contradicts, and local `main` levelled with `origin/main`. Anything the
session could not confirm is marked as such, with where it looked (for example "`eas
build:list` not checked; the build number comes from memory").

A PR opened outside `/ship` gets a `/code-review` pass on the diff first; `/ship` reviews
the diff itself, so it is not run twice.
