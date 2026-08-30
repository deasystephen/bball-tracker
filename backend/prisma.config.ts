// Prisma 7 does not auto-load .env when a prisma.config.ts exists, so load it
// here for CLI commands (migrate/seed/studio); the app loads it via src/config/env.ts.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
  migrations: {
    // Prisma 7 ignores package.json's "prisma.seed" once this config file exists.
    seed: 'tsx prisma/seed.ts',
  },
})
