const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Allow Metro to resolve files from the shared directory at the repo root
config.watchFolders = [path.resolve(monorepoRoot, 'shared')];

module.exports = config;
