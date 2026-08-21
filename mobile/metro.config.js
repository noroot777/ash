// Expo Metro config for this monorepo. The mobile app keeps its OWN node_modules
// (it is NOT an npm workspace) to avoid React / React-Native hoisting conflicts
// with the web/server packages. It only reaches OUT to `shared/` for the shared
// domain types, resolved via the repo-root `node_modules/@ash/shared`
// workspace symlink so types never drift (no build step — Metro transpiles the
// .ts that the symlink points at).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, ".."); // ash/ monorepo root

const config = getDefaultConfig(projectRoot);

// Watch the repo root so the shared sources (outside projectRoot) are crawled
// into Metro's file map.
config.watchFolders = [repoRoot];

// Resolve dependencies from the app's OWN node_modules only — its `@ash/shared`
// entry is a symlink (declared as a `file:../shared` dependency) that Metro follows
// out to the shared TS source. Keeping the repo-root tree out of resolution avoids
// pulling a conflicting React from the web/server packages.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Follow the `@ash/shared` symlink out to shared/src.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
