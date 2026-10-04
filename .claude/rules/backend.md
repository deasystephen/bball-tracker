---
paths:
  - "backend/**/*"
---

# Backend rules

Loads when a file under `backend/` is read. The full as-built reference for each area is in
`docs/architecture/` (see the index in `CLAUDE.md`).

- Routes → services → Prisma. Service methods return types built from named `include`/`select`
  constants; extend them rather than inlining an `include`.
- Access checks: `utils/permissions.ts` only (`canAccessTeam`, `teamAccessWhere`, `canWriteLeague`,
  `canManageStaff`, `lastHeadCoachTeams`). Never re-implement one inline; never use the global
  `User.role` as an access check; never use a read predicate as a write gate.
- Unaffiliated callers get 404 on league, season and player detail; other denials are
  `ForbiddenError` (403). Error bodies via `DetailedError.body()`; entitlement denials are 402.
- Email lookups use `utils/email-match.ts#emailEquals`; new accounts store lower-cased addresses.
- Invitation tokens are read only through the `INVITATION_*_SELECT` constants and `omitToken`.
- Writes onto `User` are guarded by `deletedAt IS NULL`; a new `User` relation goes into
  `USER_REFERENCE_SELECT`; a write that changes `User.email` spreads `EMAIL_SUPPRESSION_CLEARED`.
- URLs via `utils/urls.ts`, dates in email via `utils/format-date.ts`, brand via
  `services/mailer/templates/brand.ts`; every template ends with the shared footer and is listed in the
  mailer test's `renders`. Never log `req.originalUrl`; redact with `utils/redact.ts`.
- Logging (`utils/logger.ts`, threshold `LOG_LEVEL`): a new service method that mutates data logs
  one info-level domain event with ids only (never a name, email or token; `hashRecipient()` for an
  address); a new external call (SES, S3, WorkOS, Redis) logs its failures at warn/error with the
  failing operation named. `requestId` and `userId` arrive from the request context; do not thread
  them through signatures. No `console.*` in `src/`. Detail: `docs/architecture/backend-services.md#logging`.
- Multi-step backfills are hand-written migrations; run `.github/scripts/migration-backfill-guard.sh`
  before pushing. Never edit a migration already on `main`.
- Every endpoint change ships an API integration test (`tests/api/`) and a schema test
  (`tests/schemas/`). `src/services/` has a 100% function-coverage gate in CI.
- Real-database suites: run-id in every row, `@example.test` addresses, `removeTestRows(prisma, { run })`.
- `backend/`, `infra/` and `docker/` merges deploy to production; check for `IN_PROGRESS` games first.
