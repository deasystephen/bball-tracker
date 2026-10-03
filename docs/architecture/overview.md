# Architecture Overview

## As-built subsystem references

Detail that used to live in `CLAUDE.md` (moved 2026-09-30):

- [Backend services](backend-services.md) — layout, Redis, uploads, URLs, calendar feed, push
- [Sessions and tokens](auth-sessions.md) — verification, refresh, logout, PKCE, redaction
- [Authorization](authorization.md) — leagues, seasons, teams, games, staff, player directory
- [Roster and invitations](roster-and-invitations.md) — unified Add Player, invitation lifecycle, chips
- [Guardians](guardians.md) — PARENT role
- [Entitlements and usage](entitlements-and-usage.md) — tiers, limits, comped accounts
- [Live games](live-games.md) — Socket.io, server-derived score, tracker undo
- [Stats and lineage](stats-and-lineage.md) — finalization, ties, team-season identity
- [Account deletion](account-deletion.md)
- [Email](email.md) — SES events, bounces, complaints
- [Mobile app](mobile-app.md) — routing, guards, permission gating, errors, pickers
- [Mobile builds and OTA](../deployment/mobile-builds-and-ota.md) · [ECS deploys](../deployment/ecs-deploys.md)
- [Testing conventions](../testing/conventions.md) · [Maestro](../testing/maestro.md) · [Runbooks](../runbooks/README.md)

## System Architecture

The Hooplings application is a single containerized API backed by PostgreSQL, with Socket.io broadcasting live game updates over WebSocket and Redis providing best-effort caching.

## High-Level Architecture

```
┌─────────────┐
│  iOS App    │
│ (Expo/RN)   │
└──────┬──────┘
       │ HTTP/WebSocket
       ▼
┌─────────────────────────────────┐
│   AWS Application Load Balancer  │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│   Backend API (ECS Fargate)     │
│   - Express/Node.js             │
│   - WebSocket Server            │
└──────┬──────────────────────────┘
       │
       ├──────────────┬──────────────┐
       ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│   RDS    │  │ElastiCache│  │   S3     │
│PostgreSQL│  │  Redis   │  │  Storage │
└──────────┘  └──────────┘  └──────────┘
```

## Components

### Mobile Application
- **Technology**: React Native with Expo
- **Navigation**: Expo Router
- **State Management**: Zustand (client) + TanStack Query (server)
- **Communication**: REST API + WebSocket for real-time updates

### Backend API
- **Technology**: Node.js with TypeScript
- **Framework**: Express
- **ORM**: Prisma
- **Real-time**: Socket.io for WebSocket connections
- **Deployment**: AWS ECS Fargate (containerized)

### Data Storage
- **PostgreSQL (AWS RDS)**: Primary relational database
  - User data, teams, leagues, games
  - Historical statistics
- **Redis (AWS ElastiCache)**: Best-effort caching (fails open)
  - Usage-metering counts (60s TTL, see `services/usage-service.ts`)

### File Storage
- **AWS S3**: Object storage for images, videos, documents
- **CloudFront CDN**: Content delivery for static assets

## Data Flow

### Game Event Flow
1. Coach tracks event in mobile app
2. App sends event to backend API via HTTP
3. Backend validates and stores it in PostgreSQL, deriving the game score
   from the event log inside the same transaction
4. Backend broadcasts the event and post-change score via Socket.io to
   clients in the game's room
5. Mobile apps receive the real-time update
6. When the game is marked FINISHED, `StatsService.finalizeGameStats`
   recomputes the box score from the event log and upserts per-player and
   per-team stats rows (re-run on any post-finish event edit)

### Real-time Updates
1. Backend maintains WebSocket connections with mobile apps
2. When game state changes, backend broadcasts to all connected clients
3. Mobile apps update UI in real-time

## Security

- **Authentication**: JWT tokens with refresh tokens
- **Authorization**: Role-based access control (Coach, Parent, Player, Admin)
- **API Security**: Rate limiting, input validation
- **AWS Security**: IAM roles, VPC isolation, security groups
- **Secrets Management**: AWS Secrets Manager

## Scalability

- **Single replica by design**: Socket.io rooms and rate-limit counters live in process memory, so the
  API runs one ECS task (`MAX_REPLICAS=1`, autoscaling `max_capacity` validated to 1). The Redis
  adapter (#452) comes before any scale-out.
- **Database**: one RDS PostgreSQL instance, no read replicas.
- **Caching**: Redis (ElastiCache, single node) as a best-effort cache that fails open.
- **Load Balancing**: Application Load Balancer in front of the one task.

## Monitoring & Logging

What exists today (as built; the runbook is `../runbooks/on-call.md`):

- **Logs**: the API writes one JSON object per line (`backend/src/utils/logger.ts`) to stdout; the
  awslogs driver ships them to CloudWatch (`/ecs/bball-tracker-production`) and `infra/datadog.tf`
  forwards them to Datadog. Query `service:bball-tracker-api`; every line inside a request carries
  `requestId` and `userId`, domain events carry entity ids, and `LOG_LEVEL` (default `info`, in
  `infra/task-definition.json`) is the threshold. Detail: `backend-services.md#logging`.
- **Errors**: Sentry, backend project (Express error handler, health check, socket auth) and mobile
  project (`ErrorBoundary`, auth and onboarding flows, and since #617 every network failure and 5xx
  from the API client, tagged `endpoint_pattern` / `status`, plus http, socket and log breadcrumbs).
  URLs are redacted on both sides before they leave the process.
- **Alerting**: fifteen CloudWatch alarms (`infra/`), named `bball-tracker-production-*`, emailing
  an SNS subscription: API down and 5xx, latency, task count, CPU and memory, RDS storage,
  connections and CPU, and four SES email alarms (bounce and complaint rates, the events queue,
  #449). Nothing watches Redis. Sentry has its own alert rules. **Datadog has logs and no monitors**: its default host monitors were deleted
  because Fargate never emits `system.*` metrics (`../runbooks/on-call.md#datadog-has-logs-and-no-monitors`).
- **Health**: `GET /health` pings the database and reports the running `commit`; ECS recycles a
  task that fails it three times.
- **Mobile**: `services/log.ts` is the app's logger (console in development, Sentry breadcrumbs
  for warn/error); bare `console.*` is a lint error. Behavioural analytics is Amplitude (#616),
  separate from this.

## Deployment

- **Development**: local Docker Compose (PostgreSQL + Redis), backend and app run on the host.
- **Production**: a single AWS ECS Fargate task behind an ALB, one RDS PostgreSQL instance and a
  single-node ElastiCache Redis. There is no staging environment; a push to `main` that touches
  `backend/`, `infra/` or `docker/` deploys (`../deployment/ecs-deploys.md`).

