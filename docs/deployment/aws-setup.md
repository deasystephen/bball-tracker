# AWS Deployment Guide

This guide covers setting up and deploying the Hooplings application on AWS.

## Prerequisites

- AWS account with appropriate permissions
- AWS CLI installed and configured
- Docker installed locally
- Terraform or AWS CDK (optional, for infrastructure as code)

## AWS Services Used

- **ECS (Fargate)**: Container orchestration for backend
- **RDS PostgreSQL**: Managed database
- **ElastiCache Redis**: Managed Redis cache
- **S3**: Object storage
- **CloudFront**: CDN for static assets
- **Application Load Balancer**: Load balancing
- **ECR**: Container registry
- **CloudWatch**: Logging and monitoring
- **Secrets Manager**: Secure credential storage
- **IAM**: Access management

## Initial Setup

Terraform in `infra/` owns the VPC, RDS, ElastiCache, S3, Secrets Manager, ALB, ECS and SES
resources (`infra/README.md`); `terraform apply` from `infra/` creates them. The CLI examples in
steps 2-5 below are historical scaffolding from before Terraform, kept for orientation; do not run
them against an environment Terraform manages.

### 1. Create ECR Repository

```bash
aws ecr create-repository --repository-name bball-tracker-backend --region us-east-1
```

### 2. Set Up RDS PostgreSQL

```bash
# Create RDS instance (use AWS Console or CLI)
aws rds create-db-instance \
  --db-instance-identifier bball-tracker-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --master-username admin \
  --master-user-password <secure-password> \
  --allocated-storage 20 \
  --vpc-security-group-ids <security-group-id> \
  --db-subnet-group-name <subnet-group>
```

### 3. Create ElastiCache Redis

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id bball-tracker-redis \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --num-cache-nodes 1
```

### 4. Create S3 Bucket

```bash
aws s3 mb s3://bball-tracker-storage --region us-east-1
```

### 5. Store Secrets in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name bball-tracker/database \
  --secret-string '{"username":"admin","password":"<password>","host":"<rds-endpoint>"}'
```

## Building and Pushing Docker Image

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build image. Run from the repository root with the root as the build context:
# docker/Dockerfile COPYs backend/ and docker/ paths, and CI builds it the same way
# (.github/workflows/ci.yml, "Build & Deploy to ECS").
docker build -t bball-tracker-backend -f docker/Dockerfile .

# Tag image
docker tag bball-tracker-backend:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/bball-tracker-backend:latest

# Push image
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/bball-tracker-backend:latest
```

## ECS Task Definition

`infra/task-definition.json` (family `bball-tracker-production-api`) is the **single source of
truth** for the API task: its image, environment variables, Secrets Manager references, CPU and
memory, and CloudWatch logging. Never create a second task-definition file. CI's "Build & Deploy
to ECS" job renders it with the freshly built image tag and registers a new revision on every
deploy ([`docs/deployment/ecs-deploys.md`](ecs-deploys.md)). What the task carries is listed under
[Environment Variables](#environment-variables).

## Deploying to ECS

A deploy is a push to `main` that touches a non-Markdown file under `backend/`, `infra/`,
`docker/` or `.github/workflows/ci.yml`, or a `CI` run started by hand on `main`
([`docs/deployment/ecs-deploys.md`](ecs-deploys.md)). CI registers the task-definition revision and
updates the service. Terraform (`infra/`) owns the cluster `bball-tracker-production-cluster` and
the service `bball-tracker-production-api` (`aws_ecs_service.app` in `infra/ecs.tf`), so the
service is never created or updated by hand with the AWS CLI.

**Bootstrapping a fresh environment** (the detail is in `infra/README.md`, "Who owns the ECS task
definition"): at least one revision of the family must exist before Terraform can create the
service, so, in this order:

1. Fill in the account-specific Secrets Manager ARNs in `infra/task-definition.json` and replace
   `SENTRY_RELEASE_PLACEHOLDER` and the image tag (on a normal deploy CI does both).
2. Register the first revision once, from the repository root:

   ```bash
   aws ecs register-task-definition --cli-input-json file://infra/task-definition.json
   ```

3. `terraform apply` from `infra/` creates the cluster and the service against that family. From
   then on every revision comes from CI.

The service's `desired_count` is 1 on purpose: the API is single-replica (see [Scaling](#scaling)).

### Deploy window: avoid scheduled game times

Production deploys are rolling, with `deployment_maximum_percent = 200` (`infra/ecs.tf`), so **every
deploy briefly runs two tasks** — the old one draining and the new one taking connections. Socket.io
rooms live in process memory, so for that window a live game is split: a coach tracking on one task
and the spectators on the other stop seeing each other's events, and nobody gets an error. Clients
converge again once the old task stops and they reconnect (every broadcast and the join snapshot
carry the current score), but the gap is visible to anyone watching a game.

- **Do not deploy during scheduled game windows** (weekday evenings and weekends, in practice).
  Check for `IN_PROGRESS` games before merging anything that deploys.
- Remember what deploys: a push to `main` that starts a `CI` run and touches a non-markdown file
  under `backend/**`, `infra/**`, `docker/**` or `.github/workflows/ci.yml`, and a `CI` run
  started by hand on `main`. The daily scan's backend pull requests deploy on their own when they
  merge, in the hours after 15:00 UTC. Dependabot's do not (next section).
- The startup guard does not (and must not) trip on this overlap: it checks the configured ceiling
  (`MAX_REPLICAS`), not the live task count.
- The window closes for good with the Redis adapter (#452).

### What a deploy carries

A deploy ships everything on `main` since the commit production runs, not only the change whose
merge started it (#570).

Backend bumps that Dependabot auto-merges start no `CI` run on `main`, because auto-merge is
enabled with `GITHUB_TOKEN` and GitHub starts no workflow for an event that token caused. They
wait on `main` and go out with the next deploy. Nothing about this is a failure, but it means a
deploy can contain changes nobody was thinking of when they merged.

| Question | Answer |
| --- | --- |
| Which commit is production running? | `curl -s https://api.hooplings.com/health`, field `commit` |
| What is on `main` and not deployed? | `.github/scripts/deploy-contents.sh <commit> origin/main` |
| What did a deploy contain? | The summary of its run in Actions: "What this deploy carries" |
| How do I ship what is waiting? | Actions → CI → Run workflow on `main`, or `gh workflow run CI --ref main` |

A deploy started by hand runs the whole suite first and then deploys whatever the path filter
says. It is a production rollout like any other: check for games in progress first.

If `commit` on `/health` is `null` in production, the deploy job did not replace
`SENTRY_RELEASE_PLACEHOLDER` in `infra/task-definition.json`; the image tag of the running task
definition is the fallback:

```bash
aws ecs describe-task-definition \
  --task-definition "$(aws ecs describe-services --cluster bball-tracker-production-cluster \
    --services bball-tracker-production-api --query 'services[0].taskDefinition' --output text)" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

## Environment Variables

`infra/task-definition.json` is the **single source of truth** for the API task - plain values and
Secrets Manager references alike. Edit it and merge to main; the "Build & Deploy to ECS" job renders
it with the new image tag and registers a revision. Terraform does **not** manage the task definition
(#53), so a value written to `infra/ecs.tf` deploys nothing. New Secrets Manager ARNs to reference
come from `terraform output` (see `infra/outputs.tf`).

The API task carries the following (`infra/task-definition.json` is the live set; this inventory
was last checked against it on 2026-10-03):

- `DATABASE_URL` (secret): PostgreSQL connection string; TLS to RDS uses `certs/rds-global-bundle.pem`
  (override with `RDS_CA_BUNDLE_PATH`)
- `REDIS_URL`: ElastiCache Redis endpoint (best-effort cache; the app fails open without it)
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (secrets), `WORKOS_REDIRECT_URI`; optional `WORKOS_JWT_ISSUER`
  (default `https://api.workos.com`) for local JWKS verification of access tokens
- `ADMIN_EMAILS` (comma-separated; legacy `ADMIN_EMAIL` still read): emails granted ADMIN at first sign-up
- `ALLOWED_REDIRECT_HOSTS` / `ALLOWED_REDIRECT_SCHEMES` (defaults `localhost` / `hooplings`): allowed
  `redirect_uri` targets for `GET /auth/login`. Production sets `hooplings` explicitly in
  `infra/task-definition.json` (the #504 rename overlap ended with #513)
- `PUBLIC_APP_URL` (`https://hooplings.com`): human-facing links in emails / invite pages
- `API_BASE_URL` (`https://api.hooplings.com`): host for calendar feed / webcal URLs
  Both are read only through `backend/src/utils/urls.ts`; unset they fall back to `http://localhost:3000` (fail-loud) and the server logs a warning at boot in production.
- `DEFAULT_TIMEZONE` (`America/Los_Angeles`): time zone for dates in outbound email
- `AWS_REGION`, `S3_AVATARS_BUCKET`: avatar uploads via presigned S3 POST (bucket from `infra/s3.tf`)
- `AWS_SES_REGION`, `SES_FROM_ADDRESS` (`noreply@mail.hooplings.com`): SES mailer
- `SES_CONFIGURATION_SET` (`bball-tracker-production-transactional`), `SES_EVENTS_QUEUE_URL` (the
  SQS queue from `terraform output ses_events_queue_url`): SES event publishing and the in-process
  bounce/complaint consumer; both are off when unset. `SES_CONFIGURATION_SET` must never be
  deployed ahead of the `terraform apply` that creates the set (`infra/README.md`, "Email — SES,
  DKIM, MAIL FROM, and DMARC"; `docs/architecture/email.md`)
- `SENTRY_DSN` (secret), `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (injected by CI from the git SHA)
- `CORS_ORIGIN`: comma-separated list of exact browser origins allowed to call the API
  (`https://api.hooplings.com,https://hooplings.com,https://www.hooplings.com`). The apex + www
  entries exist for the web invite page, whose Accept button `POST`s cross-origin from
  `hooplings.com` (#447). No wildcard. This is browser hygiene, not access control — the public
  accept route is an unauthenticated bearer-token endpoint; `tests/api/cors.test.ts` reads the
  value from `infra/task-definition.json`, so dropping the apex fails CI
- `PORT`, `NODE_ENV` (`production`)
- `LOG_LEVEL` (`info`): log threshold, `debug` / `info` / `warn` / `error`, read per call. Set
  `debug` on the task briefly for a diagnosis, then revert
  (`docs/architecture/backend-services.md#logging`)
- `MAX_REPLICAS` (`1`): the replica ceiling the API's startup guard checks
  (`backend/src/utils/replica-guard.ts`, #446). In production a value above 1, or one that is not a
  positive integer, makes the process **exit non-zero before it listens**; unset logs an error and
  boots. It must equal the `max_capacity` default in `infra/variables.tf` —
  `backend/tests/infra/replica-ceiling.test.ts` fails CI if the two drift
- `REDIS_SOCKET_ADAPTER_URL`: not set, and **setting it does nothing today** —
  `@socket.io/redis-adapter` is not installed, so the guard does not accept it as a reason to run
  more than one replica. It becomes meaningful when the Redis adapter lands (#452)

Not used by the backend despite older docs: `JWT_SECRET` (WorkOS signs the JWTs) and `S3_BUCKET`.
(Kafka was removed entirely — the config stub, `kafkajs` dependency, and local containers are gone.)

## Load Balancer Setup

1. Create Application Load Balancer
2. Configure target group pointing to ECS service
3. Set up health checks
4. Configure HTTPS listener with SSL certificate

## Monitoring

Alerting is declared in `infra/alerting.tf` (#448); the response procedure is
[`docs/runbooks/on-call.md`](../runbooks/on-call.md). Every alarm publishes to one SNS topic with
an email subscriber (`alert_email` in the gitignored `terraform.tfvars`; `alerts@hooplings.com`
since 2026-09-29, #555), on both ALARM and OK.

- [x] ECS service: no running task, CPU and memory sustained high
- [x] RDS: connection count, free storage, CPU sustained high
- [x] Application error rates: ALB-generated 5xx and target 5xx, unhealthy target
- [x] API response times: ALB target response time p99
- [x] Uptime: Route 53 HTTPS health check on `https://api.hooplings.com/health`

Declared is not the same as live: the alarms exist in AWS only after a manual `terraform apply`,
and deliver nothing until the SNS subscription is confirmed from the inbox. The apply and
verification steps are in the runbook.

Outside Terraform, and not covered by the list above: the two Sentry issue-alert rules (runbook,
"Sentry alert rules"). Datadog receives the API's logs and has no monitors; its default host
monitors were deleted on 2026-09-29 (runbook, "Datadog has logs, and no monitors").

## Scaling

**The API is pinned to a single task (#446).** Socket.io uses the in-memory adapter and every rate
limiter keeps its counters in process memory, so a second task silently splits live games and
multiplies each rate limit. Three things hold the line, and they change together:

- `infra/variables.tf`: `max_capacity` defaults to 1 and its `validation` block rejects any other
  value, so a `terraform.tfvars` override cannot raise it (`min_capacity` accepts 0 or 1; 0 exists
  for maintenance windows).
- `infra/task-definition.json`: `MAX_REPLICAS=1`, read by the startup guard.
- `backend/src/utils/replica-guard.ts`: refuses to start in production above a ceiling of 1.

The autoscaling target and its CPU target-tracking policy stay defined in `infra/ecs.tf`; with
min = max = 1 the policy has no room to act. **Do not raise capacity as a fix for load.** The order
is: Redis adapter plus a Redis-backed rate-limit store first (#452), capacity second.

Verify the live ceiling with:

```bash
aws application-autoscaling describe-scalable-targets --service-namespace ecs \
  --resource-ids service/bball-tracker-production-cluster/bball-tracker-production-api \
  --query 'ScalableTargets[0].[MinCapacity,MaxCapacity]'
```

## Cost Optimization

- Use appropriate instance sizes
- Enable RDS automated backups with retention
- Use S3 lifecycle policies
- Monitor and optimize CloudWatch log retention

## Security Best Practices

- Use IAM roles for ECS tasks (not access keys)
- Store secrets in Secrets Manager
- Use VPC for network isolation
- Enable encryption at rest for RDS and S3
- Use security groups to restrict access
- Enable CloudTrail for audit logging

