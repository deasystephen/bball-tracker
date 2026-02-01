# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Basketball Tracker is a monorepo with a React Native/Expo mobile app and Node.js/TypeScript backend. It uses event-driven architecture with Kafka and Flink for real-time game tracking and statistics.

## Common Commands

### Backend (`/backend`)
```bash
npm run dev              # Start dev server with hot reload
npm run build            # Compile TypeScript
npm run lint             # ESLint check
npm run lint:fix         # Fix linting errors
npm run type-check       # Type check without build
npm test                 # Run Jest tests
npm test -- --testPathPattern="game" # Run single test file
npm run prisma:generate  # Generate Prisma client after schema changes
npm run prisma:migrate   # Run database migrations
npm run prisma:studio    # Open Prisma Studio GUI
```

### Mobile (`/mobile`)
```bash
npm start       # Start Expo dev server
npm run ios     # Run on iOS simulator
npm run android # Run on Android emulator
npm run lint    # ESLint check
npm run type-check # Type check
```

### Infrastructure
```bash
docker-compose up -d   # Start local services (PostgreSQL, Redis, Kafka, Zookeeper)
docker-compose down    # Stop local services
```

## Architecture

### System Flow
```
iOS App (Expo/React Native)
    ↓ HTTP/WebSocket
Backend API (Node.js/Express)
    ├── PostgreSQL (Prisma ORM)
    ├── Redis (caching)
    └── Kafka → Flink (event streaming/aggregation)
```

### Backend Structure (`/backend/src/`)
- **api/**: Route handlers organized by resource (auth, games, teams, leagues, players, invitations)
- **services/**: Business logic layer (game-service.ts, team-service.ts, etc.)
- **kafka/**: Kafka producers/consumers for event streaming
- **websocket/**: Socket.io handlers for real-time updates
- **models/**: Prisma ORM models
- **utils/**: Helpers (logger, errors, workos-client)

### Mobile Structure (`/mobile/`)
- **app/**: Expo Router screens (file-based routing)
- **components/**: Reusable UI components
- **services/**: API clients
- **store/**: Zustand stores (auth, user state)
- **hooks/**: Custom React hooks
- **i18n/**: Internationalization

### Key Patterns
- Layered architecture: API routes → Services → Models (Prisma)
- Event-driven: Kafka for game events, Flink for real-time aggregation
- Real-time: Socket.io WebSocket for live game updates
- State management: Zustand (client) + TanStack Query (server state) in mobile
- Authentication: JWT + WorkOS

## Code Style

- **Files**: kebab-case (e.g., `game-service.ts`)
- **Classes/Types/Interfaces**: PascalCase
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- Prefer explicit TypeScript types over `any`
- Use async/await over raw promises
- Validate inputs with Zod schemas

## Testing Requirements

When adding new features or fixing bugs, always write tests that verify behavior as it runs in the actual app:

### API Endpoints
- **Always add API integration tests** (in `tests/api/`) that test the full request/response cycle through Express routes
- API tests catch validation issues, middleware problems, and response format errors that service-only tests miss
- Test with realistic data formats (e.g., both UUID and custom string IDs if the database allows both)

### Validation Schemas
- **Add schema validation tests** (in `tests/schemas/`) for Zod schemas
- Test edge cases: empty strings, invalid formats, boundary values, required vs optional fields
- Ensure schema validation matches what the database actually accepts

### Service Layer
- Service tests (`tests/services/`) are valuable but not sufficient alone
- Service tests mock the database, so they don't catch mismatches between API validation and database constraints

### Test Coverage Principle
> Tests should exercise code paths as they run in production. If a request goes through validation → route → service → database, tests should cover that full path, not just the service layer with mocks.

### Example: What We Learned
A bug where the API rejected valid league IDs (`downtown-youth-league`) wasn't caught because:
1. Service tests bypassed API validation (called services directly)
2. No API tests existed for the seasons endpoint
3. Test factories used different ID formats than the seed data

The fix: Add API integration tests AND schema validation tests for every endpoint.

## Git Workflow

- Main branches: `main` and `develop`
- Feature branches from `main`: `feature/your-feature-name`
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`

## Local Development Setup

1. Start services: `docker-compose up -d`
2. Backend setup:
   ```bash
   cd backend && npm install
   npm run prisma:generate
   npm run prisma:migrate
   npm run dev
   ```
3. Mobile setup:
   ```bash
   cd mobile && npm install
   npm start
   ```
