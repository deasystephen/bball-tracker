/**
 * Environment configuration loader
 * This file MUST be imported first, before any other modules that use environment variables
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load .env from the backend directory
const envPath = resolve(process.cwd(), '.env');
const result = dotenv.config({ path: envPath });

if (result.error && !existsSync(envPath)) {
  console.warn(`Warning: .env file not found at ${envPath}`);
  console.warn('Make sure you are running from the backend/ directory and that .env exists');
}

// This ensures the module is executed (side effect)
export {};
