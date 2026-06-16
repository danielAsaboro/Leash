#!/usr/bin/env node
/**
 * drug-reference — a REAL minimal MCP server (JSON-RPC 2.0 over newline-delimited stdio) bundled with
 * the Medicine Assistant plugin. It exposes one tool, `drug_info`, over a small embedded reference set.
 * No network, no deps — pure Node — so it runs offline like the rest of Mycelium. Reference only; not
 * medical advice. This is what `${CLAUDE_PLUGIN_ROOT}` resolves to once the plugin is installed.
 */
import { createInterface } from "node:readline";

const SERVER = { name: "drug-reference", version: "1.0.0" };

/** A tiny, clearly-labeled reference set (adult, general — not a prescription). */
const DRUGS = {
  ibuprofen: { class: "NSAID", adult: "200–400 mg every 4–6 h; max 1200 mg/day OTC.", cautions: "GI bleed/ulcer risk; avoid in late pregnancy; caution with renal impairment.", interacts: ["warfarin", "aspirin", "lisinopril"] },
  acetaminophen: { class: "Analgesic/antipyretic", adult: "500–1000 mg every 4–6 h; max 3000–4000 mg/day.", cautions: "Hepatotoxic in overdose; watch combined products.", interacts: ["warfarin", "alcohol"] },
  amoxicillin: { class: "Aminopenicillin antibiotic", adult: "250–500 mg every 8 h (indication-dependent).", cautions: "Penicillin allergy; rash in mononucleosis.", interacts: ["methotrexate", "warfarin"] },
  lisinopril: { class: "ACE inhibitor", adult: "Typical 10–40 mg once daily.", cautions: "Hyperkalemia, angioedema, cough; avoid in pregnancy.", interacts: ["ibuprofen", "potassium", "spironolactone"] },
  warfarin: { class: "Anticoagulant", adult: "Individualized to INR.", cautions: "Narrow therapeutic index; many interactions; monitor INR.", interacts: ["ibuprofen", "acetaminophen", "amoxicillin"] },
};

function lookup(name) {
  const key = String(name ?? "").trim().toLowerCase();
  const d = DRUGS[key];
  if (!d) return `No reference entry for "${name}". Known: ${Object.keys(DRUGS).join(", ")}. (Reference only — not medical advice.)`;
  return [`${key} — ${d.class}`, `Adult dosing: ${d.adult}`, `Cautions: ${d.cautions}`, `May interact with: ${d.interacts.join(", ")}`, `(Reference only — confirm with a clinician/pharmacist.)`].join("\n");
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const TOOLS = [
  {
    name: "drug_info",
    description: "Look up adult dosing, cautions, and known interactions for a common medication by name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Medication name, e.g. 'ibuprofen'." } }, required: ["name"] },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    return; // ignore non-JSON noise
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER });
  } else if (method === "notifications/initialized" || method?.startsWith?.("notifications/")) {
    // notification — no response
  } else if (method === "tools/list") {
    ok(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    if (name !== "drug_info") return err(id, -32602, `unknown tool "${name}"`);
    ok(id, { content: [{ type: "text", text: lookup(params?.arguments?.name) }] });
  } else if (method === "ping") {
    ok(id, {});
  } else if (id !== undefined) {
    err(id, -32601, `method not found: ${method}`);
  }
});
