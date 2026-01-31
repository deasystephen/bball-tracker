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
