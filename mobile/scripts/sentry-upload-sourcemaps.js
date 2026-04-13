#!/usr/bin/env node
/**
 * EAS build post-success hook: upload JS bundles + sourcemaps to Sentry.
 *
 * Runs inside the EAS build container after a successful build. No-ops if
 * SENTRY_AUTH_TOKEN is unset so dev builds / PR-level preview builds don't
 * require the credential.
 *
 * Requires these env vars to be set on the EAS build profile:
 *   SENTRY_AUTH_TOKEN   (secret)
 *   SENTRY_ORG
 *   SENTRY_PROJECT
 *
 * Uses `@sentry/react-native`'s bundled CLI helper.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    console.error(`[sentry] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }
}

function main() {
  const rawToken = process.env.SENTRY_AUTH_TOKEN;
  if (!rawToken) {
    console.log('[sentry] SENTRY_AUTH_TOKEN not set; skipping sourcemap upload.');
    return;
  }

  // Strip whitespace — common paste error when setting EAS env vars.
  // Sentry API rejects tokens containing spaces/newlines with
  // "Invalid token header" (HTTP 401).
  const token = rawToken.trim();
  if (token !== rawToken) {
    console.warn(
      '[sentry] SENTRY_AUTH_TOKEN had leading/trailing whitespace; stripped. ' +
        'Re-set the env var with a clean value to silence this warning.'
    );
  }
  if (!token) {
    console.error('[sentry] SENTRY_AUTH_TOKEN is whitespace-only; cannot upload.');
    process.exit(1);
  }
  process.env.SENTRY_AUTH_TOKEN = token;

  const release =
    process.env.SENTRY_RELEASE ||
    process.env.EAS_BUILD_GIT_COMMIT_HASH ||
    process.env.EAS_BUILD_ID;
  if (!release) {
    console.warn('[sentry] No release identifier resolved; skipping upload.');
    return;
  }

  const distDir = path.resolve(process.cwd(), 'dist');
  if (!existsSync(distDir)) {
    console.warn(`[sentry] No dist/ directory at ${distDir}; skipping upload.`);
    return;
  }

  console.log(`[sentry] Uploading sourcemaps for release ${release}`);
  run('npx', ['@sentry/cli', 'releases', 'new', release]);
  // @sentry/cli v2 replaced "releases files <rel> upload-sourcemaps <dir>"
  // with "sourcemaps upload --release <rel> <dir>".
  run('npx', ['@sentry/cli', 'sourcemaps', 'upload', '--release', release, distDir]);
  run('npx', ['@sentry/cli', 'releases', 'finalize', release]);
  console.log('[sentry] Sourcemap upload complete.');
}

main();
