// Metro config adapted for the npm-workspaces monorepo so apps/mobile can
// resolve workspace packages such as @circuit/core.
// https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so changes in packages/* are picked up.
config.watchFolders = [workspaceRoot];

// Resolve modules from both the app's own node_modules and the hoisted root one.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// expo-sqlite's web worker imports its wa-sqlite WASM binary directly; treat
// .wasm as a resolvable asset (dev/web-preview only — native iOS uses the
// real SQLite binding and never hits this path).
config.resolver.assetExts.push('wasm');

module.exports = config;
