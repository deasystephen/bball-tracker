#!/bin/bash

# WorkOS Integration Verification Script

echo "🔍 Verifying WorkOS Integration..."
echo ""

# Check if WorkOS package is installed
echo "1. Checking WorkOS package..."
if [ -d "node_modules/@workos-inc" ]; then
    echo "   ✅ WorkOS package installed"
else
    echo "   ❌ WorkOS package not found. Run: npm install"
    exit 1
fi

# Check if Prisma client is generated
echo ""
echo "2. Checking Prisma client..."
if [ -d "node_modules/.prisma/client" ]; then
    echo "   ✅ Prisma client generated"
else
    echo "   ⚠️  Prisma client not found. Run: npm run prisma:generate"
fi

# Check environment variables
echo ""
echo "3. Checking environment variables..."
if [ -f ".env" ]; then
    if grep -q "WORKOS_API_KEY" .env; then
        echo "   ✅ WORKOS_API_KEY found in .env"
    else
        echo "   ⚠️  WORKOS_API_KEY not set in .env"
    fi
    
    if grep -q "WORKOS_CLIENT_ID" .env; then
        echo "   ✅ WORKOS_CLIENT_ID found in .env"
    else
        echo "   ⚠️  WORKOS_CLIENT_ID not set in .env"
    fi
else
    echo "   ⚠️  .env file not found. Copy from env.example"
fi

# Check TypeScript compilation
echo ""
echo "4. Checking TypeScript compilation..."
if npm run type-check 2>&1 | grep -q "error TS"; then
    echo "   ❌ TypeScript errors found. Run: npm run type-check"
    npm run type-check 2>&1 | grep "error TS" | head -5
else
    echo "   ✅ TypeScript compilation successful"
fi

# Check if auth routes exist
echo ""
echo "5. Checking auth routes..."
if [ -f "src/api/auth/routes.ts" ]; then
    echo "   ✅ Auth routes file exists"
else
    echo "   ❌ Auth routes file not found"
fi

# Check if WorkOS service exists
echo ""
echo "6. Checking WorkOS service..."
if [ -f "src/services/workos-service.ts" ]; then
    echo "   ✅ WorkOS service file exists"
else
    echo "   ❌ WorkOS service file not found"
fi

echo ""
echo "✨ Verification complete!"
echo ""
echo "Next steps:"
echo "1. Set up WorkOS account: https://workos.com"
echo "2. Add credentials to .env file"
echo "3. Run: npm run prisma:migrate (if not done)"
echo "4. Test: npm run dev"
echo "5. Visit: http://localhost:3000/api/v1/auth/login"
