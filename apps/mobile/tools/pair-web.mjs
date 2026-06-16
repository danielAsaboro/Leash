/**
 * Leash — device pairing web page (with live pairing confirmation).
 *
 * "Springs up" a broadsheet page showing a QR that encodes a mesh provider's public key
 * plus a callback URL on this machine's LAN address. Open Leash on the phone → tap the
 * logo → "Scan QR to pair" → point at this code. On a successful scan the phone POSTs the
 * callback, and this page flips to a "✓ Paired with <device>" success state, then closes.
 *
 * Generates the QR locally; nothing leaves the machine except the phone's LAN callback.
 *
 *   node tools/pair-web.mjs [<64-hex-provider-key>] [<provider-name>] [<port>]
 */
import http from "node:http";
import os from "node:os";
import QRCode from "qrcode";

const DEFAULT_KEY = "6035ed47dc94d96f434ff77e7f0955f0e7a3da5bae6cfddeb935be44e73af87e";
const key = (process.argv[2] || DEFAULT_KEY).trim();
const name = process.argv[3] || "This Mac";
const port = Number(process.argv[4] || 8790);

if (!/^[0-9a-f]{64}$/i.test(key)) {
  console.error("❌ provider key must be 64 hex chars");
  process.exit(1);
}

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}
const host = lanIP();
const cb = `http://${host}:${port}/paired`;
const payload = `leash://pair?provider=${key}&name=${encodeURIComponent(name)}&cb=${encodeURIComponent(cb)}`;

const qrSvg = await QRCode.toString(payload, {
  type: "svg",
  errorCorrectionLevel: "M",
  margin: 1,
  color: { dark: "#191712", light: "#f1efe6" },
});

/** Pairing state, flipped when the phone POSTs /paired. */
let paired = null; // { device, at }

function page() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Leash — Pair a device</title>
<style>
  :root{--cream:#f1efe6;--paper:#f7f5ed;--ink:#191712;--ink-soft:#3b382f;--muted:#6c685c;--faint:#9b9588;--rule:#d4cfbf;--sage:#3f7d4e;--sage-deep:#2c5a39}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--cream);color:var(--ink);
    font-family:Georgia,"Times New Roman",serif;display:flex;align-items:center;justify-content:center;padding:32px}
  .card{max-width:520px;width:100%;text-align:center}
  .mark{width:54px;height:54px;border-radius:14px;background:var(--ink);display:inline-flex;align-items:center;justify-content:center}
  .kicker{font-family:ui-monospace,"SF Mono",Menlo,monospace;text-transform:uppercase;letter-spacing:.18em;font-size:.7rem;color:var(--sage-deep);margin:22px 0 6px}
  h1{font-size:2.4rem;margin:0 0 8px;letter-spacing:-.5px}
  .dek{color:var(--ink-soft);font-size:1.05rem;line-height:1.55;margin:0 auto 26px;max-width:420px}
  .qr{background:var(--paper);border:1px solid var(--rule);border-radius:14px;padding:22px;display:inline-block;box-shadow:0 8px 30px rgba(25,23,18,.12)}
  .qr svg{width:260px;height:260px;display:block}
  .rule{height:1px;background:var(--ink);margin:28px 0 18px}
  .steps{text-align:left;max-width:420px;margin:0 auto;color:var(--ink-soft);font-size:1rem;line-height:1.7}
  .steps b{color:var(--ink)}
  .key{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.72rem;color:var(--faint);word-break:break-all;margin-top:22px}
  .foot{font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:.16em;font-size:.6rem;color:var(--faint);margin-top:24px}
  .name{font-family:ui-monospace,monospace;font-size:.8rem;color:var(--sage-deep);letter-spacing:.1em;text-transform:uppercase;margin-top:10px}
  .check{width:84px;height:84px;border-radius:50%;background:var(--sage);color:var(--cream);font-size:46px;line-height:84px;margin:0 auto 18px;animation:pop .4s ease}
  @keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
  .closing{font-family:ui-monospace,monospace;font-size:.7rem;color:var(--faint);margin-top:22px;letter-spacing:.1em}
</style></head>
<body><div class="card" id="card">
  <span class="mark"><svg width="28" height="28" viewBox="0 0 64 64" fill="none">
    <line x1="32" y1="20" x2="20.5" y2="36.5" stroke="#f1efe6" stroke-width="11" stroke-linecap="round"/>
    <line x1="32" y1="20" x2="43.5" y2="36.5" stroke="#f1efe6" stroke-width="11" stroke-linecap="round"/>
    <line x1="24" y1="42" x2="40" y2="42" stroke="#f1efe6" stroke-width="11" stroke-linecap="round"/>
    <circle cx="32" cy="15" r="9" fill="#f1efe6"/><circle cx="18" cy="42" r="9" fill="#f1efe6"/><circle cx="46" cy="42" r="9" fill="#f1efe6"/>
    <circle cx="32" cy="31.5" r="4.75" fill="#191712"/></svg></span>
  <div id="pending">
    <div class="kicker">Pair a device · The mesh</div>
    <h1>Lend this device's brain</h1>
    <p class="dek">Scan with Leash on your phone to offload its chat to this provider over an encrypted peer-to-peer link.</p>
    <div class="qr">${qrSvg}</div>
    <div class="name">Provider · ${name}</div>
    <div class="rule"></div>
    <div class="steps">
      <b>1.</b> Open <b>Leash</b> on your phone.<br/>
      <b>2.</b> Tap the <b>logo</b> (top-left) to open <b>The Mesh</b>.<br/>
      <b>3.</b> Tap <b>Scan QR to pair</b> and point at this code.<br/>
      <b>4.</b> Send a message — it runs <b>here</b>, streamed back encrypted.
    </div>
    <div class="key">${key}</div>
    <div class="foot">On-device · Private · Encrypted end-to-end · No cloud</div>
  </div>
  <div id="success" style="display:none">
    <div class="check">✓</div>
    <div class="kicker">Paired</div>
    <h1 id="successName">Device connected</h1>
    <p class="dek">This phone is now linked to <b>${name}</b> over the encrypted mesh. Its chat runs here.</p>
    <div class="closing" id="closing">Connected · disconnect on the phone to unpair</div>
  </div>
</div>
<script>
  // Live pairing status: success while the phone is connected, QR when it disconnects.
  async function poll(){
    try{
      const r = await fetch('/status',{cache:'no-store'});
      const s = await r.json();
      const pend = document.getElementById('pending'), suc = document.getElementById('success');
      if(s.paired){
        pend.style.display='none'; suc.style.display='block';
        if(s.device) document.getElementById('successName').textContent = s.device + ' connected';
      } else {
        suc.style.display='none'; pend.style.display='block';
      }
    }catch(e){}
    setTimeout(poll, 1500);
  }
  poll();
</script>
</body></html>`;
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "content-type": type + "; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

http
  .createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (url === "/status") return send(res, 200, JSON.stringify({ paired: !!paired, device: paired?.device }));
    if (url === "/paired" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let device, connected = true;
        try {
          const j = JSON.parse(body || "{}");
          device = j.device;
          if (j.connected === false) connected = false;
        } catch {}
        if (connected) {
          paired = { device: device || "A device", at: Date.now() };
          console.log(`\n✅ Paired: ${paired.device} connected to ${name}\n`);
        } else {
          console.log(`\n🔌 ${device || "A device"} disconnected from ${name}\n`);
          paired = null;
        }
        send(res, 200, JSON.stringify({ ok: true }));
      });
      return;
    }
    return send(res, 200, page(), "text/html");
  })
  .listen(port, () => {
    console.log(`\n🔗 Leash pairing page → http://localhost:${port}  (LAN: http://${host}:${port})`);
    console.log(`   provider: ${name} · ${key.slice(0, 16)}…`);
    console.log(`   callback: ${cb}\n`);
    console.log("Open that URL in a browser, then scan it from Leash on your phone.\n");
  });
