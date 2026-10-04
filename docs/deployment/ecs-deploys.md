# ECS deploys: task definition, safety, what a deploy carries

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## The ECS task definition lives in ONE file (#53)

`infra/task-definition.json` is the **single source of truth** for the API task definition — image,
environment variables, Secrets Manager references, health check, cpu/memory. CI's **Build & Deploy
to ECS** job renders it with the new image tag, registers a revision and updates the service.

**Terraform does not manage the task definition.** `infra/ecs.tf` owns the cluster, service, IAM
roles, log group, ALB and auto-scaling, and deliberately declares no `aws_ecs_task_definition` —
the two copies had drifted by 20 revisions and 7 environment variables before this was fixed.

So: **to add or change an env var or secret reference, edit `infra/task-definition.json` and merge
it.** Writing the value into `infra/ecs.tf` or a `.tfvars` file changes nothing and fails silently —
this is how a WorkOS or SES credential ends up "configured" while production keeps using the old
one. Terraform declares no `container_image` / `task_cpu` / `task_memory` / `admin_emails`
variables any more, precisely so there is nowhere wrong to put them. The Secrets Manager and IAM
role ARNs the JSON carries each have an output in `infra/outputs.tf`, read one at a time with
`terraform output -raw <name>`; the block under "Who owns the ECS task definition" in
`infra/README.md` lists the names.

`aws_ecs_service.app` is configured with the bare family name plus
`ignore_changes = [task_definition]`, so `terraform apply` never disturbs the revision CI chose.

## ECS deploy safety

`infra/ecs.tf` enables `deployment_circuit_breaker { enable = true, rollback = true }` on the
production service (#73). A rollout that never reaches a steady state is rolled back to the last
good task-definition revision automatically, and the CI deploy job
(`aws-actions/amazon-ecs-deploy-task-definition`, `wait-for-service-stability: true`) then fails —
so a bad deploy shows up as a red **Build & Deploy to ECS** job, not a silent outage. This matters
because `desired_count` is 1 at `deployment_minimum_healthy_percent = 50`: ECS may stop the old
task before the new one is healthy, so without the breaker a crash-looping image takes production
down until someone notices.

**It catches crashes, not semantic regressions.** A deploy that still answers `/health` but breaks
a query path rolls out normally — the breaker is not a substitute for a staging gate (#73).

**Every deploy briefly splits live games — avoid scheduled game windows.** The rollout runs with
`deployment_maximum_percent = 200`, so for a short overlap the old and the new task both hold
connections. Socket.io rooms are in process memory (single-replica, #446), so a coach tracking on
one task and the spectators on the other stop seeing each other's events until the old task stops
and clients reconnect; nobody gets an error. Check for `IN_PROGRESS` games before merging anything
that deploys, and before starting a deploy by hand. Of the automated merges, the daily scan's
backend pull requests deploy on their own and Dependabot's do not (next section). The startup guard
(`utils/replica-guard.ts`) checks the configured ceiling, not the live task count, so it does not
trip on the overlap. The window only closes with the Redis adapter (#452). Operator-facing copy:
`docs/deployment/aws-setup.md` ("Deploy window").

## Keep-alive vs the ALB idle timeout (#749)

The ALB keeps HTTP keep-alive connections to the task open and reuses them for up to its idle
timeout: **60 s**, the AWS default (`aws_lb.main` in `infra/ecs.tf` sets no `idle_timeout`). The
target must keep idle connections open **longer**, or the ALB occasionally sends a request down
a connection Node is closing at that instant and answers the client with a 502 the application
never saw (no request log, no Sentry event, only `HTTPCode_ELB_5XX_Count`). Node 22's default
`keepAliveTimeout` is 5 s, so `backend/src/index.ts` sets `httpServer.keepAliveTimeout = 65_000`
and `headersTimeout = 66_000` (headers above keep-alive, as Node requires). `tests/health.test.ts`
pins both above a named 60 s ALB constant. If the ALB's `idle_timeout` is ever raised, raise the
Node values above it in the same change.

## What a deploy carries (#570)

**A deploy ships everything on `main` since the commit production runs, not only the change whose
merge started it.** The two kinds of automated merge behave differently, because of the token that
enabled auto-merge:

| Merge | Enabled by | `CI` run on `main` | Deploys |
| --- | --- | --- | --- |
| Dependabot, backend (`dependabot-auto-merge.yml`) | `GITHUB_TOKEN` | **none**: GitHub starts no workflow for an event caused by that token | **no**. It waits on `main` |
| Daily scan, backend (`claude/auto-deps-*`) | the Claude GitHub App's token | yes | **yes, unattended**, in the hours after 15:00 UTC (#481 did, on 2026-09-02) |
| A person, or Claude Code with the owner's `gh` login | a user token | yes | yes, when the push touches the deploy paths |

A waiting Dependabot bump is not picked up by a later documentation or mobile merge either:
`detect-changes` looks at the commits of the triggering push only. It ships with the next push that
touches the deploy paths, or with a deploy started by hand. In September 2026 five backend bumps
waited up to 18 days and went out inside a deploy described as a capacity pin.

- **Which commit production runs:** `curl -s https://api.hooplings.com/health` returns `commit`
  (`utils/release.ts#deployedCommit`, read from `SENTRY_RELEASE`, which the deploy job sets to the
  commit; `null` anywhere else). It is the commit the answering task was built from.
- **What is waiting:** `git log <that commit>..origin/main -- backend infra docker .github/workflows/ci.yml ':(exclude,glob)**/*.md'`,
  or `.github/scripts/deploy-contents.sh <that commit> origin/main` for the same list as Markdown.
- **Every deploy says what it carries.** The job's summary (the run's page in Actions) has "What
  this deploy carries": the change that started it, and under "Merged earlier without a deploy,
  shipped now" everything that was waiting. After the rollout it adds the commit `/health` reports.
  **When a deploy misbehaves, read that list before blaming the change that was merged.** Both
  steps are `continue-on-error` and their scripts always exit 0: a summary never stops a deploy.
- **Deploying by hand:** Actions → CI → Run workflow, branch `main` (or
  `gh workflow run CI --ref main`). The whole suite runs, then the deploy, whatever the path
  filter says. This is the way to ship a waiting security bump at a chosen time, instead of
  merging an unrelated backend change to carry it. On any other branch the run tests and does not
  deploy.
- **Kept on purpose:** Dependabot's merges do not deploy. Making them deploy means enabling
  auto-merge with a token that starts workflows, and then every Monday's bumps, and security
  updates on any day, roll production unattended and split live games. Revisit after the Redis
  adapter (#452) and a staging gate (#73).
- The deploy paths are written twice, in the path filter of `ci.yml` and in
  `.github/scripts/deploy-contents.sh`; `tests/infra/deploy-contents.test.ts` fails when they
  differ, runs the script against a repository it builds, and pins the wiring `/health` depends on.
  The deploy job itself runs only on `main`, so no test or pull request can prove a deploy.

**Terraform is never applied by CI, but merging a `.tf` file still deploys.** These are two
separate mechanisms and it is easy to conflate them:

- **CI only runs `terraform fmt -check` and `terraform validate`** (`terraform-validate` job in
  `ci.yml`, `init -backend=false`, no credentials). A `.tf` change still needs a manual
  `terraform apply` from `infra/` (S3 remote state, DynamoDB lock) — **apply first, then merge**
  (#500). Merging the file does *not* apply it.
- **Merging it does trigger a full ECS deploy anyway.** `detect-changes` in `ci.yml` filters on
  `{backend/**,infra/**,docker/**,.github/workflows/ci.yml}` minus `**/*.md`, so any non-markdown
  file under `infra/` rebuilds the image and rolls a new task-definition revision — applying none
  of your Terraform changes.

So a `.tf`-only merge causes a production rollout that does *not* contain the infra change you
made. Apply first, then commit, and expect the merge to redeploy. (A `terraform apply` on its own
does **not** redeploy: `aws_ecs_service.app` has `lifecycle { ignore_changes = [task_definition] }`,
per #53.)

Note `Detect backend changes: skipping` on a **pull request** proves nothing about whether the
merge will deploy — that job is gated on `github.event_name == 'push' && github.ref ==
'refs/heads/main'`, so it skips on every PR regardless of paths. Read the path filter, not the PR
check. Verify a service-level change landed with:
`aws ecs describe-services --cluster bball-tracker-production-cluster --services bball-tracker-production-api --query 'services[0].deploymentConfiguration'`
