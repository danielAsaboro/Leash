/**
 * One-command live-swarm adapter test: spawns a publisher + a fetcher as two real
 * processes (two stores, two Hyperswarms) and replicates an adapter between them over
 * the actual swarm — the same transport two Macs use. Single machine, no GPU.
 *
 *   npm run smoke:adapter-mesh
 *
 * PASS = the fetcher prints "🟢 PASS — adapter replicated over the live swarm".
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "smoke-adapter-mesh.ts");
const base = mkdtempSync(join(tmpdir(), "adapter-mesh-"));
const invite = join(base, "invite.txt");
const run = (args: string[]) => spawn("npx", ["tsx", script, ...args], { stdio: ["ignore", "inherit", "inherit"] });

console.log("🌐 live-swarm adapter test: publisher + fetcher, real Hyperswarm…\n");
const pub = run(["publish", join(base, "storeA"), invite]);
const fetcher = run(["fetch", join(base, "storeB"), invite, join(base, "dest")]);

const cleanup = () => { try { pub.kill("SIGTERM"); } catch {} rmSync(base, { recursive: true, force: true }); };
fetcher.on("exit", (code) => { cleanup(); process.exit(code ?? 1); });
process.on("SIGINT", () => { cleanup(); process.exit(130); });
