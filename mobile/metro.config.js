// getSentryExpoConfig wraps Expo's getDefaultConfig and stamps a Debug ID into
// every bundle and its source map (#644): the bundle embedded by `eas build`
// and every OTA bundle `eas update` exports. Sentry matches an event's frames
// to the uploaded map by that id, whatever release the event carries.
// `__tests__/sentry-symbolication.test.ts` fails if this goes back to the
// plain `expo/metro-config`.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..');

const config = getSentryExpoConfig(projectRoot);

// Allow Metro to resolve files from the shared directory at the repo root
config.watchFolders = [path.resolve(monorepoRoot, 'shared')];

module.exports = config;
