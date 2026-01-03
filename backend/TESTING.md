# Backend Testing Guide

This guide will help you verify that the backend is set up correctly and working as expected.

## Prerequisites

Before testing, ensure you have:
- Node.js 18+ installed
- Docker and Docker Compose installed (for local services)
- npm or yarn package manager

## Step-by-Step Testing Process

### 1. Install Dependencies

```bash
cd backend
npm install
```

This will install all required packages including Express, Prisma, TypeScript, and testing tools.

### 2. Set Up Environment Variables

```bash
# Copy the example environment file
cp env.example .env

# Edit .env with your configuration
# For local testing, the defaults should work if Docker services are running
```

The `.env` file should have at minimum:
```env
NODE_ENV=development
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/bball_tracker?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="test-secret-key"
JWT_REFRESH_SECRET="test-refresh-secret"
CORS_ORIGIN="http://localhost:19006"
```

### 3. Start Docker Services

From the project root directory:

```bash
# Start PostgreSQL, Redis, and Kafka
docker-compose up -d

# Verify services are running
docker-compose ps
```

You should see:
- `bball-tracker-postgres` (PostgreSQL on port 5432)
- `bball-tracker-redis` (Redis on port 6379)
- `bball-tracker-zookeeper` (Zookeeper on port 2181)
- `bball-tracker-kafka` (Kafka on port 9092)

### 4. Set Up Database

```bash
# Generate Prisma Client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# (Optional) Open Prisma Studio to view database
npm run prisma:studio
```

The migration will create all tables in the PostgreSQL database.

### 5. Type Check

Verify TypeScript compilation:

```bash
npm run type-check
```

This should complete without errors.

### 6. Lint Check

Verify code quality:

```bash
npm run lint
```

Fix any issues if needed:
```bash
npm run lint:fix
```

### 7. Start the Development Server

```bash
npm run dev
```

You should see:
```
Server running on port 3000
Environment: development
```

### 8. Test API Endpoints

#### Health Check

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

#### API Root

```bash
curl http://localhost:3000/api/v1
```

Expected response:
```json
{
  "message": "API v1"
}
```

#### 404 Handler

```bash
curl http://localhost:3000/unknown-route
```

Expected response:
```json
{
  "error": "Not found"
}
```

### 9. Run Automated Tests

```bash
npm test
```

This will run the test suite including:
- Health check endpoint test
- API root endpoint test
- 404 handler test

### 10. Verify Database Connection

You can verify the database is working by checking Prisma Studio:

```bash
npm run prisma:studio
```

This opens a browser interface at `http://localhost:5555` where you can view and interact with your database tables.

### 11. Test WebSocket Connection

You can test WebSocket connections using a tool like:
- [Socket.io Client Tester](https://amritb.github.io/socketio-client-tool/)
- Or create a simple test client

Connect to: `http://localhost:3000`

You should see a connection message in the server logs.

## Troubleshooting

### Port Already in Use

If port 3000 is already in use:
1. Change `PORT` in `.env` file
2. Or stop the process using port 3000

### Database Connection Error

If you get database connection errors:
1. Verify Docker services are running: `docker-compose ps`
2. Check DATABASE_URL in `.env` matches Docker setup
3. Try restarting PostgreSQL: `docker-compose restart postgres`

### Prisma Client Not Generated

If you see "PrismaClient is not generated" errors:
```bash
npm run prisma:generate
```

### TypeScript Errors

If you see TypeScript errors:
1. Run `npm run type-check` to see all errors
2. Ensure all dependencies are installed: `npm install`
3. Check `tsconfig.json` is correct

## Expected Results

When everything is working correctly:

✅ Server starts without errors  
✅ Health endpoint returns 200 OK  
✅ API endpoints respond correctly  
✅ Database migrations run successfully  
✅ Tests pass  
✅ No TypeScript compilation errors  
✅ No linting errors  

## Next Steps

Once verification is complete, you can:
1. Start building API endpoints (auth, games, etc.)
2. Set up Kafka producers/consumers
3. Implement WebSocket event handlers
4. Add more comprehensive tests

## Additional Testing Tools

- **Postman/Insomnia**: For API endpoint testing
- **Prisma Studio**: For database inspection
- **Redis CLI**: For Redis testing (`docker exec -it bball-tracker-redis redis-cli`)
- **Kafka Console Consumer**: For testing Kafka topics

