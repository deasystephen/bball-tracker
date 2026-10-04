#!/bin/bash

# Backend Setup Verification Script
# Checks the local backend setup. Exits 1 when a ❌ check fails; ⚠️ lines are advisory.

FAILED=0

echo "🔍 Verifying Backend Setup..."
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "❌ node_modules not found. Run 'npm install' first."
    exit 1
else
    echo "✅ node_modules found"
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Run: cp env.example .env"
    FAILED=1
else
    echo "✅ .env file found"
fi

# Check if Prisma client is generated
if [ ! -d "node_modules/.prisma" ]; then
    echo "❌ Prisma client not generated. Run 'npm run prisma:generate'"
    FAILED=1
else
    echo "✅ Prisma client generated"
fi

# Check Docker services (docker-compose.yml defines exactly these two containers)
echo ""
echo "🔍 Checking Docker services..."
if docker ps | grep -q "bball-tracker-postgres"; then
    echo "✅ PostgreSQL container running"
else
    echo "❌ PostgreSQL container not running. Start with: docker-compose up -d"
    FAILED=1
fi

if docker ps | grep -q "bball-tracker-redis"; then
    echo "✅ Redis container running"
else
    echo "❌ Redis container not running. Start with: docker-compose up -d"
    FAILED=1
fi

# Type check (judged by exit status, not by grepping the output)
echo ""
echo "🔍 Running TypeScript type check..."
if npm run type-check > /dev/null 2>&1; then
    echo "✅ No TypeScript errors"
else
    echo "❌ TypeScript errors found"
    npm run type-check
    FAILED=1
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
    echo "❌ Verification failed. Fix the items marked ❌ above."
    exit 1
fi

echo "✨ Verification complete!"
echo ""
echo "Next steps:"
echo "1. Start the server: npm run dev"
echo "2. Test endpoints: curl http://localhost:3000/health"
echo "3. Run tests: npm test"
