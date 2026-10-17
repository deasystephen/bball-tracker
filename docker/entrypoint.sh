#!/bin/sh
set -e

echo "Running database migrations..."
./node_modules/.bin/prisma migrate deploy

echo "Starting server..."
# Keep in step with backend/package.json#start (not `npm start` here: npm would swallow SIGTERM).
exec node dist/src/index.js
