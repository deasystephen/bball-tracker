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
 * Env on the EAS builder: SENTRY_AUTH_TOKEN (the EAS production environment).
 * The org and project come from the ios/sentry.properties the plugin wrote, so
 * the commits land on the project the maps went to, whatever SENTRY_ORG and
 * SENTRY_PROJECT the environment exports.
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
  // The app project is the one with `<name>/Info.plist` next to it; a stray
  // project left in a local ios/ has none. More than one candidate: refuse.
  const candidates = fs
    .readdirSync(iosDir)
    .filter((entry) => entry.endsWith('.xcodeproj'))
    .map((xcodeproj) => ({
      plistPath: path.join(iosDir, xcodeproj.replace(/\.xcodeproj$/, ''), 'Info.plist'),
      pbxprojPath: path.join(iosDir, xcodeproj, 'project.pbxproj'),
    }))
    .filter(({ plistPath, pbxprojPath }) => fs.existsSync(plistPath) && fs.existsSync(pbxprojPath));
  if (candidates.length !== 1) return null;
  const [{ plistPath, pbxprojPath }] = candidates;

  const plist = readPlist(plistPath);
  let bundleId = plist.CFBundleIdentifier;
  if (!isLiteral(bundleId)) {
    // Expo's template writes $(PRODUCT_BUNDLE_IDENTIFIER); the value is in the
    // build settings. An app extension target adds `<app id>.<suffix>`, so the
    // app's id is the one every other id extends.
    const ids = [
      ...new Set(
        [...fs.readFileSync(pbxprojPath, 'utf8').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map(
          (match) => match[1]
        )
      ),
    ].sort((a, b) => a.length - b.length);
    const [shortest] = ids;
    bundleId =
      shortest && ids.every((id) => id === shortest || id.startsWith(`${shortest}.`)) ? shortest : undefined;
  }
  const version = plist.CFBundleShortVersionString;
  const build = plist.CFBundleVersion;
  if (![bundleId, version, build].every(isLiteral)) return null;
  return { bundleId, version, build };
}

/**
 * Org and project from the `ios/sentry.properties` the Expo plugin writes at
 * prebuild (`defaults.org`, `defaults.project`), the same file the Xcode
 * upload phase reads. Null when either is missing.
 */
function readSentryProperties(iosDir) {
  const file = path.join(iosDir, 'sentry.properties');
  if (!fs.existsSync(file)) return null;
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*defaults\.(org|project)\s*=\s*(\S+)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values.org && values.project ? { org: values.org, project: values.project } : null;
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

  const iosDir = path.resolve(process.cwd(), 'ios');

  // Pin the org and project to what the plugin wrote, whatever the builder's
  // environment exports (postota:production pins them the same way).
  const target = readSentryProperties(iosDir);
  if (!target) {
    console.warn('[sentry] non-fatal: no org/project in ios/sentry.properties; skipping commit association.');
    return;
  }
  process.env.SENTRY_ORG = target.org;
  process.env.SENTRY_PROJECT = target.project;

  let release = process.env.SENTRY_RELEASE;
  if (!release) {
    let parts = null;
    try {
      parts = readIosReleaseParts(iosDir, readPlistWithPlutil);
    } catch (error) {
      console.warn(`[sentry] non-fatal: could not read the iOS project: ${error.message}`);
    }
    if (!parts) {
      console.warn('[sentry] non-fatal: could not resolve the release name; skipping commit association.');
      return;
    }
    release = sentryReleaseName(parts);
  }

  console.log(`[sentry] Associating commits with release ${release} in ${target.org}/${target.project}`);
  // `releases new` is idempotent: the Xcode upload phase normally created it.
  if (!runSoft(['releases', 'new', release])) return;
  // --auto resolves the repo and commit range through the Sentry GitHub
  // integration; --ignore-missing tolerates EAS's shallow checkout.
  runSoft(['releases', 'set-commits', release, '--auto', '--ignore-missing']);
  runSoft(['releases', 'finalize', release]);
}

module.exports = { sentryReleaseName, readIosReleaseParts, readSentryProperties };

if (require.main === module) main();
