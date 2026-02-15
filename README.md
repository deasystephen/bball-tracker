# Basketball Tracker

A basketball tracking app for youth leagues, featuring real-time game tracking, player statistics, and team management. Built with React Native/Expo for iOS, a Node.js/TypeScript backend, and event-driven architecture using Kafka and Flink.

## Features

- **Real-time Game Tracking** — Play-by-play event recording with live WebSocket updates
- **Team & Roster Management** — Create teams, invite players, manage rosters
- **Managed Players (COPPA Compliant)** — Coaches can add minors to rosters without requiring email accounts or signups
- **Multi-role Access** — Coaches, Players, Parents, and Admins with role-based permissions
- **League & Season Management** — Organize teams into leagues with seasonal schedules
- **Statistics & Analytics** — Per-player and per-team stats with real-time aggregation
- **Invitation System** — Invite players and staff to teams with in-app notifications
- **Profile Pictures** — S3 presigned URL uploads with avatar picker
- **Dark Mode** — Full light/dark theme support throughout the app
- **E2E Testing** — Maestro test flows for core user journeys

## Tech Stack

### Mobile (iOS)
- React Native with Expo (SDK 52)
- Expo Router (file-based navigation)
- TanStack Query (server state)
- Zustand (client state)
- i18n (internationalization)

### Backend
- Node.js with TypeScript
- Express + Zod validation
- Prisma ORM (PostgreSQL)
- WorkOS (authentication)
- Socket.io (real-time WebSocket)
- Kafka + Flink (event streaming)

### Infrastructure
- **Compute**: AWS ECS Fargate
- **Database**: AWS RDS PostgreSQL
- **Cache**: AWS ElastiCache Redis
- **Streaming**: Confluent Cloud Kafka + Apache Flink
- **CI/CD**: GitHub Actions → Docker → ECR → ECS
- **Domain**: `api.capyhoops.com` with HTTPS (ACM cert)
- **Observability**: Datadog (via CloudWatch Forwarder)
- **Mobile Builds**: Expo Application Services (EAS)
- **E2E Testing**: Maestro
- **Analytics**: Amplitude

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- iOS Simulator (Xcode) for mobile development

### Local Development

1. Clone and install:
```bash
git clone https://github.com/deasystephen/bball-tracker.git
cd bball-tracker
```

2. Start local services (PostgreSQL, Redis, Kafka, Zookeeper):
```bash
docker-compose up -d
```

3. Set up the backend:
```bash
cd backend
npm install
cp .env.example .env   # Edit with your config
npx prisma generate
npx prisma migrate dev
npm run dev
```

4. Start the mobile app:
```bash
cd mobile
npm install
npx expo run:ios        # Builds native modules and runs on simulator
```

> **Note**: Use `npx expo run:ios` instead of `npx expo start` to avoid native module version mismatches.

## Project Structure

```
bball-tracker/
├── mobile/              # React Native/Expo iOS app
│   ├── app/             #   Expo Router screens (file-based routing)
│   ├── components/      #   Reusable UI components
│   ├── hooks/           #   Custom React hooks
│   ├── services/        #   API clients
│   ├── store/           #   Zustand state stores
│   ├── theme/           #   Colors, spacing, typography
│   └── i18n/            #   Internationalization
├── backend/             # Node.js API server
│   ├── src/api/         #   Route handlers (auth, games, teams, players, etc.)
│   ├── src/services/    #   Business logic layer
│   ├── src/kafka/       #   Kafka producers/consumers
│   ├── src/websocket/   #   Socket.io handlers
│   ├── prisma/          #   Schema, migrations, seed data
│   └── tests/           #   Jest test suites
├── .maestro/            # Maestro E2E test flows
├── infra/               # Terraform (ECS, RDS, ElastiCache)
├── docker/              # Dockerfile and entrypoint
├── streaming/           # Kafka/Flink configurations
├── shared/              # Shared types
└── docs/                # Documentation
```

## Common Commands

### Backend
```bash
npm run dev                # Start dev server with hot reload
npm test                   # Run all tests (543 tests across 29 suites)
npm run type-check         # TypeScript type checking
npx prisma migrate dev     # Run database migrations
npx prisma studio          # Open database GUI
```

### Mobile
```bash
npx expo run:ios           # Build and run on iOS simulator
npm run type-check         # TypeScript type checking
```

### E2E Tests
```bash
maestro test .maestro/             # Run all Maestro flows
maestro test .maestro/login.yaml   # Run a single flow
```

### Deployment
```bash
# Backend deploys automatically via CI/CD on push to main
# Mobile OTA update:
npx eas-cli update --branch preview --platform ios --message "description"
# Mobile production build:
npx eas-cli build --platform ios --profile production --non-interactive
```

## Architecture

```
iOS App (Expo/React Native)
    ↓ HTTP / WebSocket
Backend API (Express + TypeScript)
    ├── PostgreSQL (Prisma ORM) — persistent data
    ├── Redis — caching
    ├── Kafka → Flink — event streaming & aggregation
    └── WorkOS — authentication
```

Game events flow through Kafka for real-time processing. Flink aggregates statistics as events stream in. Socket.io pushes live updates to connected clients during active games.

## Deployment

The backend deploys via GitHub Actions CI/CD:
1. Push to `main` triggers the pipeline
2. Docker image is built and pushed to AWS ECR
3. ECS Fargate service pulls the new image
4. `prisma migrate deploy` runs automatically on container start
5. Logs forward to Datadog via CloudWatch Forwarder

Mobile builds use Expo Application Services (EAS):
- **OTA updates** push JavaScript bundle changes without a full rebuild
- **Production builds** create IPA files for TestFlight/App Store submission

## License

This project is licensed under the Apache License 2.0 — see [LICENSE](LICENSE) for details.
