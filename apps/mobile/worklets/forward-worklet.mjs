/**
 * Bare worklet — the mobile side of hypha's PRODUCTION "forward" P2P path (the phone half of
 * apps/hypha/src/forward-control.ts). Runs hyperswarm INSIDE the Bare runtime (react-native-bare-kit)
 * and bridges to React Native over BareKit.IPC with newline-delimited JSON.
 *
 * It borrows ANY modality (text chat, vision, …) from a mesh provider's LOCAL serve: the provider's
 * forward server proxies the request to its resident model, so the phone never loads weights and the
 * provider never duplicates the model / contends for the registry corestore.
 *
 * RN → worklet:  { id, providerKey, consumerKey, endpoint, body, timeoutMs? }
 *   · providerKey   = the mesh provider's public key (from the capability roster)
 *   · consumerKey   = THIS phone's stable mesh consumerPublicKey (allow-listed by the provider's
 *                     forward server; the consumer half of the per-pair forward topic)
 *   · endpoint/body = a raw OpenAI request, e.g. { endpoint:"/v1/chat/completions", body:{ model, messages } }
 * worklet → RN:  { id, type:"ready" } | { id, type:"chunk", data, delta? } | { id, type:"done", stats? } | { id, type:"error", error }
 *                 (delta = structured OpenAI {content?, tool_calls?, finish_reason?} for tool-aware borrow)
 *
 * The rendezvous is the per-pair topic sha256("hypha-forward-v1:<provider>:<consumer>") — IDENTICAL to
 * forward-control.ts topicForPair(). The provider's forward server only joins that topic for consumers
 * it has allow-listed (the mesh roster), so meeting on the topic IS the capability.
 */
import b4a from "b4a";
import { createHash } from "bare-crypto";
import { createForwardSwarm } from "./forward-swarm.mjs";

const TOPIC_PREFIX = "hypha-forward-v1";
const IPC = BareKit.IPC;

function out(o) {
  IPC.write(b4a.from(JSON.stringify(o) + "\n"));
}

/** Mirror forward-control.ts topicForPair(): sha256("hypha-forward-v1:<provider>:<consumer>") → 32-byte topic. */
function topicForPair(providerKey, consumerKey) {
  return createHash("sha256").update(`${TOPIC_PREFIX}:${providerKey}:${consumerKey}`).digest();
}

// The single in-flight request's teardown — an `{ abort: true }` from RN cancels the provider's decode
// (sends a forward-control `{ id, cancel: true }` so the provider aborts its local serve fetch) and then
// drops the swarm connection, freeing the phone immediately. Safe on SDK 0.13.1.
let active = null;

let inbuf = "";
IPC.on("data", (chunk) => {
  inbuf += b4a.toString(chunk);
  const parts = inbuf.split("\n");
  inbuf = parts.pop() || "";
  for (const line of parts) {
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req && req.abort) {
      if (active) active(); // tear down the in-flight forward → RN gets a "done" and unblocks
      continue;
    }
    onRequest(req);
  }
});

function onRequest(req) {
  const id = req.id || "1";
  if (!req.providerKey || !req.consumerKey) {
    out({ id, type: "error", error: "mesh forward: missing provider/consumer key" });
    return;
  }
  let topic;
  try {
    topic = topicForPair(req.providerKey.trim(), req.consumerKey.trim());
  } catch (e) {
    out({ id, type: "error", error: "mesh forward: bad topic — " + (e && e.message) });
    return;
  }

  const swarm = createForwardSwarm();
  let finished = false;
  const finish = (o) => {
    if (finished) return;
    finished = true;
    active = null;
    clearTimeout(timer);
    out(o);
    swarm.destroy().catch(() => {});
  };
  active = () => finish({ id, type: "done", stats: { aborted: true } });
  const timer = setTimeout(
    () => finish({ id, type: "error", error: "mesh forward timed out — is the provider's forward server running?" }),
    req.timeoutMs || 180_000,
  );

  swarm.on("connection", (conn) => {
    let b = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      b += b4a.toString(chunk);
      const ps = b.split("\n");
      b = ps.pop() || "";
      for (const l of ps) {
        if (!l) continue;
        let f;
        try {
          f = JSON.parse(l);
        } catch {
          continue;
        }
        if (f.id && f.id !== id) continue; // multiplex guard
        // Relay the structured OpenAI `delta` (tool_calls / finish_reason) alongside the text `data`
        // so the RN side's onDelta fires for tool-aware borrow (Stage 3). Absent for plain-text turns.
        if (f.type === "chunk") out({ id, type: "chunk", data: f.data, ...(f.delta ? { delta: f.delta } : {}) });
        else if (f.type === "done") finish({ id, type: "done", stats: f.stats });
        else if (f.type === "error") finish({ id, type: "error", error: f.error });
      }
    });
    // Once connected, an RN abort cancels the provider's decode (forward-control `{ id, cancel: true }`)
    // before dropping the connection — the provider aborts its local serve fetch instead of draining.
    // Let the cancel frame FLUSH before tearing down the swarm: writing then immediately destroying
    // loses the frame (the peer sees only a connection reset). A short grace flushes it; the provider's
    // own conn-close handler is the backstop if even that races.
    active = () => {
      try { conn.write(b4a.from(JSON.stringify({ id, cancel: true }) + "\n")); } catch { /* peer gone */ }
      setTimeout(() => finish({ id, type: "done", stats: { aborted: true } }), 250);
    };
    // The forward-control.ts ForwardRequest shape: { id, endpoint, body }.
    conn.write(b4a.from(JSON.stringify({ id, endpoint: req.endpoint || "/v1/chat/completions", body: req.body }) + "\n"));
  });

  swarm.join(topic, { client: true, server: false });
}

out({ type: "ready" });
