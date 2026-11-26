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

## Within-run checklist

A long run fills the context window and older turns get summarised. A checklist in a file
survives that. It lives in the session scratchpad directory, never in the repo (a stray
`TASKS.md` would also silence the docs Stop hook, which treats any changed `.md` as "docs
considered") and never in memory: GitHub issues remain the only store for work that outlives
the session.

## Closing message

Lead with what needs the user (a decision left open, a merge to approve), then Changed,
Verified and Wrap-up. Wrap-up is the sweep `CLAUDE.md` asks for: tests, docs, issues the
change closes or contradicts, and local `main` levelled with `origin/main`. Anything the
session could not confirm is marked as such, with where it looked (for example "`eas
build:list` not checked; the build number comes from memory").

A PR opened outside `/ship` gets a `/code-review` pass on the diff first; `/ship` reviews
the diff itself, so it is not run twice.
