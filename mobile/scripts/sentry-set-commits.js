#!/usr/bin/env node
/**
 * EAS build post-success hook (`eas-build-on-success` in package.json):
 * attach the commits to the Sentry release this iOS build reports (#220, #644).
 *
 * Source maps are NOT uploaded here any more. The `@sentry/react-native/expo`
 * config plugin adds an Xcode build phase that uploads the embedded bundle's
 * maps (Debug IDs, from getSentryExpoConfig in metro.config.js) and the dSYMs
 * during the build itself, and `npm run ota:production` uploads every OTA
 * bundle's maps. What is left for this hook is commit association, so that
 * "Fixes <SENTRY-SHORT-ID>" in a commit resolves the issue and suspect commits
 * work. It must name the release the events carry: the app leaves `release`
 * unset (services/sentry.ts), so the SDK reports the native default
 * `<bundle id>@<CFBundleShortVersionString>+<CFBundleVersion>`, which is also
 * the release the Xcode phase uploads under. SENTRY_RELEASE, when set, wins on
 * both sides (app.config.js `extra.sentryRelease`).
 *
 * Best-effort by design: the build already succeeded and its maps are
 * uploaded, so every failure here warns and exits 0. Skips without
 * SENTRY_AUTH_TOKEN (the EAS preview environment has none) and on Android
 * (no Android binary is shipped yet; its release name would need the Gradle
 * values).
 *
 * Env on the EAS builder: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT (the
 * EAS production environment).
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** `<bundle id>@<version>+<build>`: the Sentry Cocoa SDK's default release name. */
function sentryReleaseName({ bundleId, version, build }) {
  return `${bundleId}@${version}+${build}`;
}

/** The value Xcode build settings would substitute is unknown here: refuse it. */
function isLiteral(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('$(');
}

/**
 * Reads bundle id, version and build number from the iOS project prebuild
 * generated and EAS stamped (it writes CFBundleShortVersionString and the
 * auto-incremented CFBundleVersion into Info.plist before compiling).
 * `readPlist(file)` returns the plist as an object; injectable for tests.
 * Returns null when any value cannot be resolved to a literal.
 */
function readIosReleaseParts(iosDir, readPlist) {
  if (!fs.existsSync(iosDir)) return null;
  const xcodeproj = fs.readdirSync(iosDir).find((entry) => entry.endsWith('.xcodeproj'));
  if (!xcodeproj) return null;
  const target = xcodeproj.replace(/\.xcodeproj$/, '');
  const plistPath = path.join(iosDir, target, 'Info.plist');
  const pbxprojPath = path.join(iosDir, xcodeproj, 'project.pbxproj');
  if (!fs.existsSync(plistPath) || !fs.existsSync(pbxprojPath)) return null;

  const plist = readPlist(plistPath);
  let bundleId = plist.CFBundleIdentifier;
  if (!isLiteral(bundleId)) {
    // Expo's template writes $(PRODUCT_BUNDLE_IDENTIFIER); the value is in the
    // build settings, identical for Debug and Release.
    const ids = new Set(
      [...fs.readFileSync(pbxprojPath, 'utf8').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map(
        (match) => match[1]
      )
    );
    bundleId = ids.size === 1 ? [...ids][0] : undefined;
  }
  const version = plist.CFBundleShortVersionString;
  const build = plist.CFBundleVersion;
  if (![bundleId, version, build].every(isLiteral)) return null;
  return { bundleId, version, build };
}

/** plutil ships with macOS, which every EAS iOS builder runs. */
function readPlistWithPlutil(file) {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`plutil failed on ${file}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runSoft(args) {
  const result = spawnSync('npx', ['@sentry/cli', ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn(`[sentry] non-fatal: sentry-cli ${args.join(' ')} failed`);
    return false;
  }
  return true;
}

function main() {
  const token = (process.env.SENTRY_AUTH_TOKEN || '').trim();
  if (!token) {
    console.log('[sentry] SENTRY_AUTH_TOKEN not set; skipping commit association.');
    return;
  }
  // The Sentry API rejects a token with surrounding whitespace ("Invalid
  // token header"), a common paste error in EAS env vars.
  process.env.SENTRY_AUTH_TOKEN = token;

  if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== 'ios') {
    console.log(`[sentry] ${process.env.EAS_BUILD_PLATFORM} build; commit association is iOS-only for now.`);
    return;
  }

  let release = process.env.SENTRY_RELEASE;
  if (!release) {
    let parts = null;
    try {
      parts = readIosReleaseParts(path.resolve(process.cwd(), 'ios'), readPlistWithPlutil);
    } catch (error) {
      console.warn(`[sentry] non-fatal: could not read the iOS project: ${error.message}`);
    }
    if (!parts) {
      console.warn('[sentry] non-fatal: could not resolve the release name; skipping commit association.');
      return;
    }
    release = sentryReleaseName(parts);
  }

  console.log(`[sentry] Associating commits with release ${release}`);
  // `releases new` is idempotent: the Xcode upload phase normally created it.
  if (!runSoft(['releases', 'new', release])) return;
  // --auto resolves the repo and commit range through the Sentry GitHub
  // integration; --ignore-missing tolerates EAS's shallow checkout.
  runSoft(['releases', 'set-commits', release, '--auto', '--ignore-missing']);
  runSoft(['releases', 'finalize', release]);
}

module.exports = { sentryReleaseName, readIosReleaseParts };

if (require.main === module) main();
