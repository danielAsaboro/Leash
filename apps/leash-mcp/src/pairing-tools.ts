/**
 * Mesh-pairing MCP tools — drive hypha's localhost pairing control plane (:11437)
 * with the HUMAN in the loop via MCP elicitation:
 *
 *   · mesh_pair_device({deviceName?}) — enter pairing mode, discover LAN devices,
 *     elicit a device choice when ambiguous, start pairing, elicit the 6-digit PIN
 *     (displayed on the TARGET device's screen), submit, poll to done. Decline/cancel/
 *     timeout on any form cancels the pairing honestly; a wrong PIN re-elicits (the
 *     host allows 3 attempts).
 *   · mesh_pairing_status() — read-only mesh + pairing snapshot.
 *
 * Elicitation is structurally required here: the PIN exists only on the other
 * machine's screen — no model can know it; only the user can.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HYPHA_URL } from "./config.ts";

interface Discovered {
  deviceKey: string;
  name: string;
  computeClass: string;
  fp: string;
}

interface PairState {
  mode: boolean;
  expiresInMs: number | null;
  meshOnline: boolean;
  selfName: string;
  discovered: Discovered[];
  outgoing: { targetName: string; status: "await-pin" | "pairing" | "done"; error?: string } | null;
  incoming: { initiatorName: string; pin: string } | null;
  error: string | null;
}

const DISCOVER_MS = 10_000;
const PAIR_DONE_MS = 60_000;
const POLL_MS = 1_000;
/** Above the dashboard's 120 s elicitation timeout-cancel so the web side resolves first. */
const ELICIT_TIMEOUT_MS = 130_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function hypha<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HYPHA_URL}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `hypha ${method} ${path} → HTTP ${res.status}`);
  return json;
}

const pairState = (): Promise<PairState> => hypha<PairState>("GET", "/pair/state");

async function cancelPairing(): Promise<void> {
  try {
    await hypha("POST", "/pair/cancel");
  } catch {
    /* best-effort */
  }
}

const text = (t: string): { content: Array<{ type: "text"; text: string }> } => ({ content: [{ type: "text", text: t }] });

/** Is hypha reachable at all? Null when fine, honest guidance text when not. */
async function hyphaDownText(): Promise<string | null> {
  try {
    await hypha("GET", "/health");
    return null;
  } catch {
    return `The mesh daemon (hypha) isn't reachable at ${HYPHA_URL}. Start it from the dashboard's Services page (Mesh / Hypha → Start), then try again.`;
  }
}

export function registerPairingTools(server: McpServer): void {
  server.registerTool(
    "mesh_pairing_status",
    {
      title: "Mesh pairing status",
      description: "Read-only snapshot of the device mesh: online state, paired peers, and any pairing in progress.",
      inputSchema: {},
    },
    async () => {
      const down = await hyphaDownText();
      if (down) return text(down);
      const health = await hypha<{ meshOnline: boolean; warmAliases: string[]; peers: number }>("GET", "/health");
      const peers = await hypha<{ peers: Array<{ displayName: string; live: boolean; warm: boolean; models: string[] }> }>("GET", "/peers");
      const state = await pairState();
      const lines = [
        `Mesh: ${health.meshOnline ? "online" : "offline (this device isn't paired yet)"} · ${health.peers} peer(s) · warm models: ${health.warmAliases.join(", ") || "none"}.`,
        ...peers.peers.map((p) => `· ${p.displayName} — ${p.live ? "live" : "stale"}${p.warm ? ", warm" : ""}${p.models.length ? ` (serves ${p.models.join(", ")})` : ""}`),
        state.mode ? `Pairing mode is ON (expires in ${Math.round((state.expiresInMs ?? 0) / 1000)}s); discovered: ${state.discovered.map((d) => d.name).join(", ") || "nobody yet"}.` : "Pairing mode is off.",
        state.outgoing ? `Outgoing pairing with ${state.outgoing.targetName}: ${state.outgoing.status}${state.outgoing.error ? ` (${state.outgoing.error})` : ""}.` : "",
        state.incoming ? `Incoming pairing from ${state.incoming.initiatorName} — its PIN is shown on this device's dashboard.` : "",
      ].filter(Boolean);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "mesh_pair_device",
    {
      title: "Pair a device into the mesh",
      description:
        "Pair this device with another device on the local network (both must run the mesh daemon, and the other device must have pairing mode on). Discovers nearby devices, asks the user to pick one if ambiguous, then asks the user for the 6-digit PIN shown on the OTHER device's screen.",
      inputSchema: {
        deviceName: z.string().optional().describe("Name (or part of the name) of the device to pair with, if the user said one."),
      },
    },
    async ({ deviceName }) => {
      const down = await hyphaDownText();
      if (down) return text(down);

      // One pairing at a time — a half-done outgoing attempt would be clobbered.
      const initial = await pairState();
      if (initial.outgoing && initial.outgoing.status !== "done") {
        return text(`A pairing with ${initial.outgoing.targetName} is already in progress (${initial.outgoing.status}). Finish or cancel it in the dashboard first.`);
      }

      // Enter pairing/discovery mode and give the LAN a moment to answer.
      await hypha("POST", "/pair/mode", { on: true });
      let discovered: Discovered[] = [];
      const tDiscover = Date.now();
      while (Date.now() - tDiscover < DISCOVER_MS) {
        await sleep(POLL_MS);
        discovered = (await pairState()).discovered;
        const want = deviceName?.trim().toLowerCase();
        if (want && discovered.some((d) => d.name.toLowerCase().includes(want))) break;
        if (!want && discovered.length > 0) break;
      }
      if (discovered.length === 0) {
        await cancelPairing();
        return text("No devices were discovered on the local network. Make sure the other device has its mesh daemon running with pairing mode ON (dashboard → Mesh → Add a device), then try again.");
      }

      // Resolve the target: a unique name match proceeds directly; otherwise ask the user.
      const want = deviceName?.trim().toLowerCase();
      const matches = want ? discovered.filter((d) => d.name.toLowerCase().includes(want)) : discovered;
      let target: Discovered;
      if (matches.length === 1) {
        target = matches[0] as Discovered;
      } else {
        const choice = await server.server.elicitInput(
          {
            message:
              matches.length === 0
                ? `No discovered device matches "${deviceName}". Which of these should I pair with?`
                : "Several devices are nearby. Which one should I pair with?",
            requestedSchema: {
              type: "object",
              properties: {
                device: {
                  type: "string",
                  title: "Device",
                  enum: (matches.length > 0 ? matches : discovered).map((d) => d.name),
                },
              },
              required: ["device"],
            },
          },
          { timeout: ELICIT_TIMEOUT_MS },
        );
        if (choice.action !== "accept" || !choice.content?.["device"]) {
          await cancelPairing();
          return text("Pairing cancelled — no device was chosen.");
        }
        const picked = discovered.find((d) => d.name === choice.content?.["device"]);
        if (!picked) {
          await cancelPairing();
          return text(`Pairing cancelled — "${String(choice.content["device"])}" is no longer discoverable.`);
        }
        target = picked;
      }

      // Start pairing → the TARGET device now displays a 6-digit PIN on its dashboard.
      await hypha("POST", "/pair/start", { deviceKey: target.deviceKey });

      // The host allows 3 PIN attempts; a wrong PIN re-elicits.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const pinAnswer = await server.server.elicitInput(
          {
            message:
              attempt === 1
                ? `Pairing with ${target.name}. Enter the 6-digit PIN now shown on ${target.name}'s screen.`
                : `That PIN was wrong (attempt ${attempt} of 3). Check ${target.name}'s screen and enter the 6-digit PIN again.`,
            requestedSchema: {
              type: "object",
              properties: {
                pin: { type: "string", title: "6-digit PIN", description: `Shown on ${target.name}'s dashboard` },
              },
              required: ["pin"],
            },
          },
          { timeout: ELICIT_TIMEOUT_MS },
        );
        if (pinAnswer.action !== "accept" || !pinAnswer.content?.["pin"]) {
          await cancelPairing();
          return text(`Pairing with ${target.name} cancelled — no PIN was entered.`);
        }
        const pin = String(pinAnswer.content["pin"]).replace(/\D/g, "");
        try {
          await hypha("POST", "/pair/submit-pin", { pin });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 3 && /pin/i.test(msg)) continue; // wrong PIN → re-elicit
          await cancelPairing();
          return text(`Pairing with ${target.name} failed: ${msg}`);
        }

        // PIN accepted — poll the handshake to completion.
        const tDone = Date.now();
        while (Date.now() - tDone < PAIR_DONE_MS) {
          await sleep(POLL_MS);
          const s = await pairState();
          if (s.outgoing?.status === "done") {
            return text(`Paired with ${target.name}. The mesh will warm its models shortly — check the dashboard's Mesh panel for the new peer.`);
          }
          if (s.outgoing?.error) {
            if (attempt < 3 && /pin/i.test(s.outgoing.error)) break; // wrong PIN surfaced async → re-elicit
            await cancelPairing();
            return text(`Pairing with ${target.name} failed: ${s.outgoing.error}`);
          }
          if (!s.outgoing) break; // pairing state evaporated (cancelled on the other side)
        }
        const after = await pairState();
        if (after.outgoing?.status === "done") {
          return text(`Paired with ${target.name}. The mesh will warm its models shortly — check the dashboard's Mesh panel for the new peer.`);
        }
        if (!(after.outgoing?.error && /pin/i.test(after.outgoing.error))) {
          await cancelPairing();
          return text(`Pairing with ${target.name} didn't complete within ${PAIR_DONE_MS / 1000}s — it was cancelled. Try again with both devices awake on the same network.`);
        }
      }
      await cancelPairing();
      return text(`Pairing with ${target.name} failed — 3 wrong PIN attempts.`);
    },
  );
}
