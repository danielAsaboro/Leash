const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const brainPackageRoot = path.resolve(projectRoot, "../../packages/brain");
const qvacWorkerBundlePath = path.resolve(projectRoot, "./qvac/worker.bundle.js");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), brainPackageRoot])];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@mycelium/brain": brainPackageRoot,
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@qvac/sdk/worker.mobile.bundle") {
    return {
      type: "sourceFile",
      filePath: qvacWorkerBundlePath,
    };
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
