/**
 * Bare worklet — the mobile side of hypha's "forward" P2P path (porting the proven
 * ForwardControlClient transport to the phone). Runs hyperswarm INSIDE the Bare runtime
 * (react-native-bare-kit) and bridges to React Native over BareKit.IPC with newline-JSON.
 *
 * RN → worklet:  { prompt, imageDataUrl }   (a `data:image/...;base64,...` URL)
 * worklet → RN:  { type:"ready" } | { type:"chunk", data } | { type:"done", text } | { type:"error", error }
 *
 * It joins the spike's fixed forward topic (sha256("hypha-forward-spike-v1")), sends an
 * OpenAI /v1/chat/completions body with the image inline, and streams the caption back —
 * the provider (a strong mesh node) materializes the image + runs vision locally.
 */
import Hyperswarm from "hyperswarm";
import b4a from "b4a";

const TOPIC = b4a.from("caeb2823748e266fa3f7bbaae9aecf88cccb160ff41756d434213958178f0605", "hex");
const IPC = BareKit.IPC;

function out(o) {
  IPC.write(b4a.from(JSON.stringify(o) + "\n"));
}

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
    onRequest(req);
  }
});

function onRequest(req) {
  const swarm = new Hyperswarm();
  let caption = "";
  let finished = false;
  const finish = (o) => {
    if (finished) return;
    finished = true;
    out(o);
    swarm.destroy().catch(() => {});
  };
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
        if (f.type === "chunk") {
          caption += f.data || "";
          out({ type: "chunk", data: f.data });
        } else if (f.type === "done") {
          finish({ type: "done", text: caption });
        } else if (f.type === "error") {
          finish({ type: "error", error: f.error });
        }
      }
    });
    const fwd = {
      id: "1",
      endpoint: "/v1/chat/completions",
      body: {
        model: "qwen3vl",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: req.prompt || "What is in this image? Answer in one short sentence." },
              { type: "image_url", image_url: { url: req.imageDataUrl } },
            ],
          },
        ],
      },
    };
    conn.write(b4a.from(JSON.stringify(fwd) + "\n"));
  });
  swarm.join(TOPIC, { client: true, server: false });
}

out({ type: "ready" });
