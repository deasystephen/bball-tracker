# Hooplings Backend

Node.js/TypeScript backend API for the Hooplings application.

## Tech Stack

- **Runtime**: Node.js 22+
- **Framework**: Express
- **Language**: TypeScript
- **Database**: PostgreSQL (via Prisma ORM)
- **Cache**: Redis (ioredis)
- **Real-time**: Socket.io
- **Validation**: Zod
- **Authentication**: WorkOS (AuthKit) — JWT is the session token format only
- **Email**: AWS SES via the `Mailer` interface (FakeMailer in dev/test)

## Setup

### Prerequisites

- Node.js 22+ and npm
- PostgreSQL database (local or Docker)
- Redis (local or Docker)

`docker-compose up -d` from the repo root starts both services (PostgreSQL 18 + Redis). New to
Docker? See [docs/setup/docker-installation.md](../docs/setup/docker-installation.md).

### Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp env.example .env
# Fill WORKOS_API_KEY and WORKOS_CLIENT_ID from the WorkOS dashboard (staging keys);
# the server refuses to boot without them. Every other value works as-is locally.
```

3. Set up the database:
```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed the dev-login users, teams and games (also the reset between Maestro flows)
npx prisma db seed
```

4. (Optional) Check the setup: `./scripts/verify-setup.sh` confirms `node_modules`, `.env`, the
   generated Prisma client, the two Docker containers and a clean type check.

5. Start the development server:
```bash
npm run dev
```

The server will start on `http://localhost:3000`. `curl http://localhost:3000/health` returns
`{"status":"ok","db":"ok","commit":"<sha>","timestamp":"<iso>"}` (`commit` is `null` locally; 503 with
`status: "degraded"`, `db: "down"` when PostgreSQL is unreachable).

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint errors
- `npm run type-check` - Type check without building
- `npm test` - Run tests

## Project Structure

```
backend/
├── src/
│   ├── api/          # API routes
│   ├── services/     # Business logic
│   ├── models/       # Database models (Prisma)
│   ├── websocket/    # WebSocket handlers
│   └── utils/        # Utility functions
├── prisma/           # Prisma schema and migrations
├── tests/            # Test files
└── dist/             # Compiled output
```

## Environment Variables

See `env.example` for required environment variables. Production values live in
`infra/task-definition.json`, the only source of truth for the deployed task.

| Variable | Purpose |
| --- | --- |
| `LOG_LEVEL` | Log threshold, `debug` / `info` / `warn` / `error` (default `info`). Read per call; set `debug` on the task briefly for a diagnosis, then revert. |
| `NODE_ENV` | `development` enables dev-login tokens and stack traces in error bodies; never affects log output. |

## Logging

Every line is one JSON object (`utils/logger.ts`), forwarded from CloudWatch to Datadog
(`service:bball-tracker-api`). Inside a request every line carries `requestId` and, once the
bearer token resolved, `userId`. Domain events (team created, invitation accepted, game
finished, stats finalized, …) are logged at `info` with ids only; see
`docs/architecture/backend-services.md#logging`.

## Database

The project uses Prisma ORM. Schema is defined in `prisma/schema.prisma`.

To modify the database:
1. Update `prisma/schema.prisma`
2. Create a migration: `npm run prisma:migrate`
3. Generate Prisma client: `npm run prisma:generate`

## API Documentation

API routes are organized by resource under `src/api/<resource>/`. See the per-resource test suites under `tests/api/` for working examples of every endpoint.

## Testing

```bash
npm test                 # Jest (unit + API integration suites)
npm run test:db          # Only the real-database suites (needs docker-compose Postgres, migrated)
```

Conventions (API tests, schema tests, real-database suites, migration guard) and the manual smoke
scripts under `scripts/` are described in
[docs/testing/conventions.md](../docs/testing/conventions.md).

## License

Apache 2.0

