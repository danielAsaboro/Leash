/**
 * Fresh Leash device scopes should inherit the committed starter serve config. Welcome onboarding
 * downloads that same recommended kit; zeroing `serve.models` leaves the first chat route with no
 * live aliases even after onboarding succeeds.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function seedBootstrapQvacConfig(sourceConfig) {
  const seeded = JSON.parse(JSON.stringify(sourceConfig ?? {}));
  seeded.serve ??= {};
  seeded.serve.models ??= {};
  return seeded;
}

export function bootstrapConfigFiles(scope) {
  return {
    wrapper: scope.configPath,
    base: join(dirname(scope.configPath), "qvac.config.base.json"),
  };
}

export function seedScopedQvacConfig(input) {
  const { scope, sourceDir, sourceConfig } = input;
  const files = bootstrapConfigFiles(scope);
  mkdirSync(dirname(files.wrapper), { recursive: true });
  const wrapperSrc = join(sourceDir, "qvac.config.mjs");
  if (existsSync(wrapperSrc)) cpSync(wrapperSrc, files.wrapper);
  writeFileSync(files.base, JSON.stringify(seedBootstrapQvacConfig(sourceConfig), null, 2));
}
