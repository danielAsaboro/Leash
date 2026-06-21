import { MeshRouter, type RouterMesh } from "../apps/hypha/src/mesh-router.ts";
import { isPaidSessionPeer } from "../apps/hypha/src/warm-pool.ts";

const paidRail = { network: "plasma", mint: "0xUSDT", x402: { scheme: "upto", pricePerKiloToken: 500 } };
const paidCap = { settlements: [paidRail] };

if (isPaidSessionPeer(paidCap as never, "private" as never)) {
  console.error("❌ FAIL — private mesh capability with a stale rail must not be classified as paid");
  process.exit(1);
}
if (!isPaidSessionPeer(paidCap as never, "public" as never)) {
  console.error("❌ FAIL — public mesh capability with a nonzero rail must be classified as paid");
  process.exit(1);
}

function mesh(visibility: "private" | "public", target: { requiresSession?: boolean; peerKey: string }, cap = { settlements: [paidRail] }): RouterMesh {
  const fakePool = {
    targetForAlias: (_alias: string) => target,
    capabilityForProviderKey: (_k: string) => cap,
  } as unknown as RouterMesh["pool"];
  return { meshId: visibility, label: visibility, tier: visibility === "private" ? 0 : 1, visibility, selfWriterKey: "SELF", autobaseKey: `base-${visibility}`, pool: fakePool } as RouterMesh;
}

const privateRouter = new MeshRouter(() => [mesh("private", { peerKey: "PRIVATE", inflight: 0, modelSrc: "src://chat" })]);
const privateHit = privateRouter.route({ alias: "chat", sensitivity: "private" });
console.log("private route() hit:", JSON.stringify(privateHit));
if (!privateHit || privateHit.requiresSession === true || privateHit.peerKey !== "PRIVATE" || privateHit.settlements !== undefined || privateHit.settlement !== undefined) {
  console.error("❌ FAIL — private mesh route must stay free even if a stale paid rail exists");
  process.exit(1);
}

const publicFreeRouter = new MeshRouter(() => [mesh("public", { peerKey: "PUBLIC_FREE", inflight: 0, modelSrc: "src://chat" }, { settlements: [] })]);
const publicFreeHit = publicFreeRouter.route({ alias: "chat", sensitivity: "shareable" });
console.log("public free route() hit:", JSON.stringify(publicFreeHit));
if (!publicFreeHit || publicFreeHit.requiresSession === true || publicFreeHit.peerKey !== "PUBLIC_FREE") {
  console.error("❌ FAIL — public zero-price route must not require a paid session");
  process.exit(1);
}

const publicPaidRouter = new MeshRouter(() => [mesh("public", { peerKey: "PUBLIC_PAID", inflight: 0, modelSrc: "src://chat", requiresSession: true })]);
const publicPaidHit = publicPaidRouter.route({ alias: "chat", sensitivity: "shareable" });
console.log("public paid route() hit:", JSON.stringify(publicPaidHit));
const ok = !!publicPaidHit && publicPaidHit.requiresSession === true && publicPaidHit.modelSrc === "src://chat" && publicPaidHit.peerKey === "PUBLIC_PAID";
console.log(ok ? "✅ PASS — private/free routes stay free; public paid route propagates session contract"
              : "❌ FAIL — public paid fields dropped (shim would miss paid-session path)");
process.exit(ok ? 0 : 1);
