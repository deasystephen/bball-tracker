/**
 * Shared paths for the config-bound tests that read GitHub Actions workflows
 * (`action-pins.test.ts`, `node-version.test.ts`).
 */
import { readdirSync } from 'fs';
import path from 'path';

/** Repository root (this file lives in `backend/tests/infra/`). */
export const ROOT = path.resolve(__dirname, '../../..');

export const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');

/** Every workflow file name under `.github/workflows/`, sorted. */
export function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}
