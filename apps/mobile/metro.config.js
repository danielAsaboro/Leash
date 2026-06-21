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
  // Babel lowers Android-JSC BigInt operations in watched workspace sources too;
  // make its JSBI runtime resolvable from those files outside this app directory.
  jsbi: path.dirname(require.resolve("jsbi/package.json")),
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
