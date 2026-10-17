#!/bin/sh
set -e

echo "Running database migrations..."
./node_modules/.bin/prisma migrate deploy

echo "Starting server..."
# Same file as backend/package.json#start; exec makes node PID 1, so ECS's SIGTERM and the exit code reach it directly.
exec node dist/src/index.js
