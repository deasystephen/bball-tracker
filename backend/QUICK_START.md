# Quick Start - Backend Testing

## Prerequisites

- Node.js 18+ and npm
- **Docker Desktop** (includes Docker and Docker Compose)
  - Install: `brew install --cask docker`
  - Or download from: https://www.docker.com/products/docker-desktop/
  - Make sure Docker Desktop is running before proceeding

See [Docker Installation Guide](../docs/setup/docker-installation.md) for detailed instructions.

## Fastest Way to Verify Backend Setup

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Set Up Environment
```bash
cp env.example .env
# Edit .env if needed (defaults work for local Docker setup)
```

### 3. Start Docker Services
```bash
# From project root
docker-compose up -d
```

### 4. Set Up Database
```bash
cd backend
npm run prisma:generate
npm run prisma:migrate
```

### 5. Verify Setup (Optional)
```bash
./scripts/verify-setup.sh
```

### 6. Start Server
```bash
npm run dev
```

### 7. Test Endpoints

Open a new terminal and run:

```bash
# Health check
curl http://localhost:3000/health

# API root
curl http://localhost:3000/api/v1

# Should return JSON responses
```

### 8. Run Tests
```bash
npm test
```

## Expected Output

**Server console:**
```
Server running on port 3000
Environment: development
```

**Health endpoint:**
```json
{"status":"ok","timestamp":"2024-01-01T12:00:00.000Z"}
```

**API endpoint:**
```json
{"message":"API v1"}
```

## Troubleshooting

- **Docker not installed?** See [Docker Installation Guide](../docs/setup/docker-installation.md)
- **Docker not running?** Start Docker Desktop application
- **Port in use?** Change `PORT` in `.env`
- **Database error?** Check Docker: `docker-compose ps`
- **Prisma error?** Run `npm run prisma:generate`

See [TESTING.md](./TESTING.md) for detailed testing guide.

