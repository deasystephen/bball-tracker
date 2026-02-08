# Backend Dockerfile
FROM node:20-alpine AS base
RUN apk add --no-cache openssl

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Install all deps (including dev) for building
FROM base AS builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

# Copy production node_modules (no dev deps)
COPY --from=deps /app/node_modules ./node_modules
# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
# Copy Prisma schema and migrations for runtime migrate deploy
COPY --from=builder /app/prisma ./prisma
# Copy generated Prisma client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Copy entrypoint
COPY docker/entrypoint.sh ./entrypoint.sh

# Ensure nodejs user owns the app directory
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

ENV PORT=3000

ENTRYPOINT ["./entrypoint.sh"]
