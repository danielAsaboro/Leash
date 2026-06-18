// Empirical repro: does a NAMED-namespace autobase recover WRITABLE on reopen?
// Mirrors apps/hypha MeshHost: one Corestore, mesh = rootStore.namespace(meshId), Autobase(ns, bootstrapKey).
// Tests three reopen strategies after founding + closing, to find the durable-writable one.
import Corestore from "corestore";
import Autobase from "autobase";
import b4a from "b4a";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dir = join(tmpdir(), "ab-recover-repro-" + process.pid);
const NS = "mesh-d81da1b0";

function open(store) { return store.get("view", { valueEncoding: "json" }); }
async function apply(nodes, view, host) {
  for (const n of nodes) {
    const v = n.value;
    if (v && v.type === "add-writer") { await host.addWriter(b4a.from(v.key, "hex"), { indexer: true }); continue; }
    await view.append(v);
  }
}
const opts = () => ({ valueEncoding: "json", open, apply });

async function found() {
  const store = new Corestore(dir);
  const base = new Autobase(store.namespace(NS), null, opts());
  await base.ready();
  const info = { writable: base.writable, key: b4a.toString(base.key, "hex"), local: b4a.toString(base.local.key, "hex") };
  if (base.writable) await base.append({ type: "hello", n: 1 });
  await base.close(); await store.close();
  return info;
}

async function reopen(bootstrapHex) {
  const store = new Corestore(dir);
  const boot = bootstrapHex ? b4a.from(bootstrapHex, "hex") : null;
  const base = new Autobase(store.namespace(NS), boot, opts());
  await base.ready();
  // give it a tick to load local state / linearize
  await new Promise((r) => setTimeout(r, 200));
  const info = { writable: base.writable, key: b4a.toString(base.key, "hex"), local: b4a.toString(base.local.key, "hex") };
  await base.close(); await store.close();
  return info;
}

(async () => {
  try {
    const f = await found();
    console.log("1) FOUND (null bootstrap):      ", JSON.stringify(f));
    console.log("   autobaseKey == localWriterKey?", f.key === f.local);

    const rKey = await reopen(f.key);
    console.log("2) REOPEN with autobaseKey:     ", JSON.stringify(rKey), "→ writable:", rKey.writable);

    const rLocal = await reopen(f.local);
    console.log("3) REOPEN with localWriterKey:  ", JSON.stringify(rLocal), "→ writable:", rLocal.writable);

    const rNull = await reopen(null);
    console.log("4) REOPEN with null:            ", JSON.stringify(rNull), "→ writable:", rNull.writable, "| sameBase:", rNull.key === f.key);

    console.log("\nVERDICT:");
    console.log("  durable-writable strategy =",
      rKey.writable ? "reopen-with-autobaseKey (current code SHOULD work — bug is elsewhere)" :
      rLocal.writable ? "reopen-with-localWriterKey (code passes the WRONG key!)" :
      (rNull.writable && rNull.key === f.key) ? "reopen-with-null (recovers same base writable)" :
      "NONE recovered writable — deeper issue");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error("repro crashed:", e); process.exit(2); });
