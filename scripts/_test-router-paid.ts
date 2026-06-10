/**
 * Regression test for the MeshRouter paid-target propagation bug.
 * A paid (registry-session) peer's target has requiresSession=true + modelSrc but NO modelId.
 * route() must propagate requiresSession + modelSrc so the shim takes the paid-session path.
 * Before the fix, route() dropped both → shim non-session path → undefined modelId → failure.
 */
import { MeshRouter, type RouterMesh } from "../apps/hypha/src/mesh-router.ts";

const paidTarget = { peerKey: "PROVIDERKEY", inflight: 0, modelSrc: "src://qwen3-4b", requiresSession: true };
const cap = { settlements: [{ network: "plasma", mint: "0xUSDT", x402: { scheme: "upto" } }] };
const fakePool = {
  targetForAlias: (_alias: string) => paidTarget,
  capabilityForProviderKey: (_k: string) => cap,
} as unknown as RouterMesh["pool"];
const mesh = { meshId: "primary", label: "Primary", tier: 0, visibility: "private", selfWriterKey: "SELF", pool: fakePool } as RouterMesh;

const router = new MeshRouter(() => [mesh]);
const hit = router.route({ alias: "qwen3-4b", sensitivity: "private" });
console.log("route() hit:", JSON.stringify(hit));

const ok = !!hit && hit.requiresSession === true && hit.modelSrc === "src://qwen3-4b" && hit.peerKey === "PROVIDERKEY";
console.log(ok ? "✅ PASS — requiresSession + modelSrc propagated (paid-session path will fire)"
              : "❌ FAIL — paid fields dropped (shim falls to non-session path → 'no delegated model is ready')");
process.exit(ok ? 0 : 1);
