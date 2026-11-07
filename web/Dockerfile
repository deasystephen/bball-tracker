# Web Dockerfile (#30): the Next.js site at https://hooplings.com, run on ECS
# behind the API's ALB. Build context is web/:
#   docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.hooplings.com web
# The Node major matches the root .nvmrc and docker/Dockerfile
# (backend/tests/infra/node-version.test.ts).
FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
WORKDIR /app
# Inlined into the browser bundle at build time (the Accept button's POST); a
# runtime environment value never reaches the client.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN test -n "$NEXT_PUBLIC_API_URL" && npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server binds to HOSTNAME; the ALB reaches the task on its VPC address.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# `output: 'standalone'` (next.config.ts) traces the server's dependencies into
# .next/standalone; static assets and public/ (.well-known/) are copied beside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
