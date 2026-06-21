import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

const removedFiles = [
  "app/login/page.tsx",
  "app/setup-password/page.tsx",
  "app/api/leash/auth/login/route.ts",
  "app/api/leash/auth/setup/route.ts",
  "app/api/leash/auth/logout/route.ts",
  "app/api/leash/account/password/route.ts",
  "app/api/leash/auth/active/route.ts",
  "lib/leash/auth.ts",
  "lib/leash/auth-core.ts",
  "lib/auth-handshake.ts",
];

for (const relative of removedFiles) {
  assert.equal(existsSync(join(webRoot, relative)), false, `${relative} should be removed`);
}

assert.equal(existsSync(join(webRoot, "app/api/leash/device/active/route.ts")), true, "device active route should exist");
assert.equal(existsSync(join(webRoot, "lib/device-handshake.ts")), true, "device handshake helper should exist");

const filesWithoutLegacyStrings = [
  { path: "middleware.ts", blocked: ["legacyAuthRouteRedirect", "/login", "/setup-password", "/api/leash/auth/active"] },
  { path: "lib/leash/device-bootstrap-core.ts", blocked: ["legacyAuthRouteRedirect", "promoteLegacyUsers", "/login", "/setup-password", "/api/leash/auth/active"] },
  { path: "lib/leash/device-bootstrap.ts", blocked: ["migrateLegacyBootstrap", "users.json", "promoteLegacyUsers"] },
  { path: "components/LeashRail.tsx", blocked: ["/login", "/setup-password"] },
  { path: "components/AppDataCard.tsx", blocked: ["auth-handshake"] },
  { path: "components/onboarding/WelcomeFlow.tsx", blocked: ["auth-handshake"] },
];

for (const entry of filesWithoutLegacyStrings) {
  const source = readFileSync(join(webRoot, entry.path), "utf8");
  for (const blocked of entry.blocked) {
    assert.equal(source.includes(blocked), false, `${entry.path} should not mention ${blocked}`);
  }
}

console.log("verify-no-legacy-auth: ok");
