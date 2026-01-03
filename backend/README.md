# Basketball Tracker Backend

Node.js/TypeScript backend API for the Basketball Tracker application.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express
- **Language**: TypeScript
- **Database**: PostgreSQL (via Prisma ORM)
- **Cache**: Redis (ioredis)
- **Event Streaming**: Kafka (kafkajs)
- **Real-time**: Socket.io
- **Validation**: Zod
- **Authentication**: JWT

## Setup

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL database (local or Docker)
- Redis (local or Docker)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Set up the database:
```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate
```

4. Start the development server:
```bash
npm run dev
```

The server will start on `http://localhost:3000`

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
│   ├── kafka/        # Kafka producers/consumers
│   ├── websocket/    # WebSocket handlers
│   └── utils/        # Utility functions
├── prisma/           # Prisma schema and migrations
├── tests/            # Test files
└── dist/             # Compiled output
```

## Environment Variables

See `.env.example` for required environment variables.

## Database

The project uses Prisma ORM. Schema is defined in `prisma/schema.prisma`.

To modify the database:
1. Update `prisma/schema.prisma`
2. Create a migration: `npm run prisma:migrate`
3. Generate Prisma client: `npm run prisma:generate`

## API Documentation

API documentation will be available at `/api/docs` (to be implemented).

## Testing

Run tests with:
```bash
npm test
```

## License

Apache 2.0

