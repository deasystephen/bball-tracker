import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

// Run through the ESLint CLI (`eslint . --max-warnings 0`), not the deprecated
// `next lint` (#690), so build output must be ignored here explicitly.
const eslintConfig = [
  { ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  // Server output goes through lib/log.ts, the one file allowed to print: its
  // JSON lines are what Datadog receives, with invitation tokens masked (#966).
  { rules: { 'no-console': 'error' } },
  { files: ['lib/log.ts'], rules: { 'no-console': 'off' } },
];

export default eslintConfig;
