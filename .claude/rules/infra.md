---
paths:
  - "infra/**/*"
  - "docker/**/*"
  - ".github/**/*"
---

# Infra and deploy rules

Loads when a file under `infra/`, `docker/` or `.github/` is read. Detail: `docs/deployment/ecs-deploys.md`,
`docs/deployment/aws-setup.md`, `docs/runbooks/README.md`.

- `infra/task-definition.json` is the only source of truth for the ECS task definition. Env vars
  and secret references go there and nowhere else; Terraform ignores `task_definition`.
- CI never applies Terraform: `terraform apply` from `infra/` (S3 state, DynamoDB lock) **before**
  merging, and expect the merge to redeploy the API without the infra change.
- Any non-Markdown change under `backend/`, `infra/`, `docker/` or `.github/workflows/ci.yml`
  deploys on merge and carries everything waiting on `main`. Check for `IN_PROGRESS` games first;
  the rolling overlap splits live games.
- Replica ceiling is 1 everywhere (`max_capacity` validation, `MAX_REPLICAS=1`, startup guard);
  do not raise it before the Redis adapter (#452).
- `SES_CONFIGURATION_SET` deploys only after the apply that creates the set. SES stays on
  `mail.hooplings.com`; Google Workspace owns the apex mail records; DMARC policy changes only via
  `local.dmarc_policy`. Registrar-created zones and console-created records are imported, never created.
- Alarm thresholds are `alarm_*` variables; tune in tfvars. Turning off Container Insights breaks
  the task-count alarm.
- `backend/tests/infra/*.test.ts` pin task-definition values, deploy paths, the Postgres major and
  the replica ceiling; change the test and the file together.
- Third-party actions (owner not `actions/` or `github/`) are pinned to a 40-character commit SHA
  with a `# vX.Y.Z` comment in every workflow; `backend/tests/infra/action-pins.test.ts` enforces it.
- Every `actions/setup-node` step reads `node-version-file: .nvmrc`; `.nvmrc`, `engines.node` and
  the Dockerfile's `FROM node:<major>` agree (`backend/tests/infra/node-version.test.ts`).
- The deploy paths are written twice (the `ci.yml` filter and `.github/scripts/deploy-contents.sh`);
  a test fails when they differ.
