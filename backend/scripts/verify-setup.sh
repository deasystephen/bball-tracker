#!/bin/bash

# Backend Setup Verification Script
# This script checks if the backend is properly set up

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
    echo "⚠️  .env file not found. Copy from env.example"
    echo "   Run: cp env.example .env"
else
    echo "✅ .env file found"
fi

# Check if Prisma client is generated
if [ ! -d "node_modules/.prisma" ]; then
    echo "⚠️  Prisma client not generated. Run 'npm run prisma:generate'"
else
    echo "✅ Prisma client generated"
fi

# Check Docker services
echo ""
echo "🔍 Checking Docker services..."
if docker ps | grep -q "bball-tracker-postgres"; then
    echo "✅ PostgreSQL container running"
else
    echo "⚠️  PostgreSQL container not running. Start with: docker-compose up -d"
fi

if docker ps | grep -q "bball-tracker-redis"; then
    echo "✅ Redis container running"
else
    echo "⚠️  Redis container not running. Start with: docker-compose up -d"
fi

if docker ps | grep -q "bball-tracker-kafka"; then
    echo "✅ Kafka container running"
else
    echo "⚠️  Kafka container not running. Start with: docker-compose up -d"
fi

# Type check
echo ""
echo "🔍 Running TypeScript type check..."
if npm run type-check 2>&1 | grep -q "error"; then
    echo "❌ TypeScript errors found"
    npm run type-check
else
    echo "✅ No TypeScript errors"
fi

echo ""
echo "✨ Verification complete!"
echo ""
echo "Next steps:"
echo "1. Start the server: npm run dev"
echo "2. Test endpoints: curl http://localhost:3000/health"
echo "3. Run tests: npm test"

