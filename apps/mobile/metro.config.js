const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const brainPackageRoot = path.resolve(projectRoot, "../../packages/brain");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), brainPackageRoot])];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@mycelium/brain": brainPackageRoot,
};

module.exports = config;
