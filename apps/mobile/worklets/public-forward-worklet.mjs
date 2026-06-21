/** Direct mobile client for Hypha's authenticated public-compute protocol. */
import b4a from "b4a";
import Hyperswarm from "hyperswarm";
import { createHash, randomBytes } from "bare-crypto";
import net from "bare-net";
import SecretStream from "@hyperswarm/secret-stream";

const IPC = BareKit.IPC;
let active = null;
let inbuf = "";
const clientSeed = randomBytes(32);

const out = (value) => IPC.write(b4a.from(JSON.stringify(value) + "\n"));
const hex = (bytes) => b4a.toString(bytes, "hex");
const uuid = () => {
  const h = hex(randomBytes(16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

IPC.on("data", (chunk) => {
  inbuf += b4a.toString(chunk);
  const lines = inbuf.split("\n");
  inbuf = lines.pop() || "";
  for (const line of lines) {
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.abort) { active?.(); continue; }
    try { run(req); }
    catch (error) { out({ id: req.id, type: "error", error: `public worklet failed: ${error?.message || String(error)}` }); }
  }
});

function run(req) {
  const id = req.id || "public-1";
  const advert = req.advert;
  const lanEndpoints = Array.isArray(advert?.lanEndpoints) ? advert.lanEndpoints : [];
  const validLanEndpoints = lanEndpoints.length <= 8 && lanEndpoints.every((endpoint) => endpoint
    && typeof endpoint.host === "string"
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(endpoint.host)
    && Number.isInteger(endpoint.port) && endpoint.port >= 1024 && endpoint.port <= 65535);
  if (!advert || !/^[0-9a-f]{64}$/i.test(advert.providerId || "") || !/^[0-9a-f]{64}$/i.test(advert.transportKey || "") || !validLanEndpoints) {
    out({ id, type: "error", error: "invalid public provider/requester identity" });
    return;
  }
  const seed = createHash("sha256").update(clientSeed).update("public-compute-client").digest();
  const swarm = new Hyperswarm({ seed });
  const requesterId = hex(swarm.keyPair.publicKey);
  const jobId = uuid();
  const startedAt = Date.now();
  const requesterRssBeforeMb = typeof process !== "undefined" && typeof process.memoryUsage === "function"
    ? Math.round(process.memoryUsage().rss / 1024 / 1024)
    : undefined;
  let conn = null;
  let connectedAt = 0;
  let connectionTransport = "unknown";
  let firstTokenAt = 0;
  let finished = false;
  const finish = (frame) => {
    if (finished) return;
    finished = true;
    active = null;
    clearTimeout(timer);
    out(frame);
    swarm.destroy().catch(() => {});
  };
  const timer = setTimeout(() => finish({ id, type: "error", error: "timeout: public provider did not finish" }), req.timeoutMs || 180000);
  active = () => {
    try { conn?.write(b4a.from(JSON.stringify({ version: 1, type: "cancel", jobId, requesterId }) + "\n")); } catch {}
    setTimeout(() => finish({ id, type: "error", error: "cancellation: public job cancelled", jobId }), 250);
  };
  const bind = (stream, remoteKey, transport) => {
    connectedAt = Date.now();
    connectionTransport = transport;
    const remote = hex(remoteKey || b4a.alloc(0));
    if (remote !== advert.transportKey) return finish({ id, type: "error", error: "authentication_failure: provider Noise identity mismatch", jobId });
    conn = stream;
    stream.on("error", () => {});
    let buf = "";
    stream.on("data", (chunk) => {
      buf += b4a.toString(chunk);
      const frames = buf.split("\n");
      buf = frames.pop() || "";
      for (const raw of frames) {
        if (!raw) continue;
        let frame;
        try { frame = JSON.parse(raw); } catch { continue; }
        if (frame.jobId !== jobId) continue;
        if (frame.type === "accepted") {
          if (frame.providerId !== advert.providerId || frame.transportKey !== advert.transportKey) return finish({ id, type: "error", error: "authentication_failure: accepted identity mismatch", jobId });
          out({ id, type: "accepted", jobId, requesterId, providerId: advert.providerId });
        } else if (frame.type === "chunk") {
          if (!firstTokenAt) firstTokenAt = Date.now();
          out({ id, type: "chunk", jobId, data: frame.data || "", ...(frame.delta ? { delta: frame.delta } : {}) });
        } else if (frame.type === "done") {
          const requesterRssAfterMb = typeof process !== "undefined" && typeof process.memoryUsage === "function"
            ? Math.round(process.memoryUsage().rss / 1024 / 1024)
            : undefined;
          finish({
            id,
            type: "done",
            jobId,
            providerId: advert.providerId,
            requesterId,
            stats: {
              ...(frame.stats || {}),
              connectionTransport,
              connectionMs: connectedAt ? connectedAt - startedAt : 0,
              requesterTtftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
              requesterTotalMs: Date.now() - startedAt,
              ...(requesterRssBeforeMb === undefined ? {} : { requesterRssBeforeMb }),
              ...(requesterRssAfterMb === undefined ? {} : { requesterRssAfterMb }),
            },
          });
        } else if (frame.type === "error") {
          finish({ id, type: "error", jobId, error: `${frame.code}: ${frame.error}` });
        }
      }
    });
    const request = {
      version: 1,
      type: "job",
      jobId,
      nonce: hex(randomBytes(32)),
      issuedAt: Date.now(),
      providerId: advert.providerId,
      requesterId,
      endpoint: "/v1/chat/completions",
      body: req.body,
    };
    stream.write(b4a.from(JSON.stringify(request) + "\n"));
  };
  swarm.on("connection", (stream, info) => bind(stream, info.publicKey, "dht"));

  const expectedKey = b4a.from(advert.transportKey, "hex");
  const dialLan = (endpoint) => new Promise((resolve) => {
    let settled = false;
    const raw = net.createConnection({ host: endpoint.host, port: endpoint.port });
    const secure = new SecretStream(true, raw, { keyPair: swarm.keyPair, remotePublicKey: expectedKey });
    const timer = setTimeout(() => finishDial(false), 2500);
    const finishDial = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) { try { secure.destroy(); } catch {} }
      resolve(ok);
    };
    raw.on("error", () => finishDial(false));
    secure.on("error", () => finishDial(false));
    secure.on("connect", () => {
      if (!secure.remotePublicKey || !b4a.equals(secure.remotePublicKey, expectedKey)) return finishDial(false);
      bind(secure, secure.remotePublicKey, "lan");
      finishDial(true);
    });
  });
  void (async () => {
    for (const endpoint of Array.isArray(advert.lanEndpoints) ? advert.lanEndpoints : []) {
      if (await dialLan(endpoint)) return;
    }
    swarm.joinPeer(expectedKey);
  })().catch((error) => finish({ id, type: "error", jobId, error: `unreachable_provider: ${error?.message || String(error)}` }));
}

out({ type: "ready" });
