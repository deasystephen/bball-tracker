/**
 * Environment configuration loader
 * This file MUST be imported first, before any other modules that use environment variables
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { logger } from '../utils/logger';

// Load .env from the backend directory
const envPath = resolve(process.cwd(), '.env');
const result = dotenv.config({ path: envPath });

// The logger reads nothing from the environment at import time (LOG_LEVEL is
// read per call), so it is safe to use before dotenv has run.
if (result.error && !existsSync(envPath)) {
  logger.warn('No .env file found; run from the backend/ directory with a .env present', {
    envPath,
  });
}

// This ensures the module is executed (side effect)
export {};
