/**
 * LIVE proof (needs `qvac serve` on :11435) of the two legs the offline smoke couldn't reach:
 *   (1) ACTIVATION ROUTING — embed a domain query + each plugin skill's routing utterances against the
 *       REAL gte-large, max-cosine per skill (exactly how skill-tools.activeSkillsSection's semantic
 *       path scores), and confirm a law query scores the law skill highest, a medical query the medicine
 *       skill, and an off-domain query neither above the activation floor (0.81).
 *   (2) SPECIALIST INFERENCE — a REAL qwen3-4b completion with the law plugin's skill body as the system
 *       prompt (exactly what the chat route injects once the skill activates), proving the generalist
 *       answers as a contract reviewer.
 * Talks straight to the local serve (no web layer, no auth). Run: `npx tsx scripts/smoke-plugins-live.ts`
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDispatcher, Agent } from "undici";
import { splitFrontmatter, parseLineList } from "@mycelium/leash-core/frontmatter";

// PATIENT fetch — no body/headers timeout (mirrors apps/web/lib/leash/provider.ts). On-device decodes
// can legitimately wait; undici's DEFAULT body-inactivity timeout would abort the stream mid-decode,
// and a mid-decode abort WEDGES the qvac serve (CLAUDE.md). So we never time the body out.
setGlobalDispatcher(new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 }));

const SERVE = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "example-plugins");

interface SkillMeta { slug: string; name: string; description: string; whenToUse: string; examples: string[]; body: string; }

async function loadSkill(plugin: string, name: string, slug: string): Promise<SkillMeta> {
  const raw = await readFile(join(EXAMPLES, plugin, "skills", name, "SKILL.md"), "utf8");
  const { fields, body } = splitFrontmatter(raw)!;
  return { slug, name: fields["name"] ?? name, description: fields["description"] ?? "", whenToUse: fields["when_to_use"] ?? "", examples: parseLineList(fields["examples"], 12), body };
}

/** Routing utterances — identical construction to skill-tools.skillUtterances. */
function utterances(s: SkillMeta): string[] {
  const discovery = `${s.slug}: ${s.description || s.name}`;
  const when = s.whenToUse ? s.whenToUse.split(/\r?\n/) : [];
  return [discovery, ...when, ...s.examples].map((u) => u.trim()).filter(Boolean).slice(0, 8);
}

async function embed(values: string[]): Promise<number[][]> {
  const r = await fetch(`${SERVE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer qvac" },
    body: JSON.stringify({ model: "gte-large", input: values }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => d.embedding);
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += (a[i] as number) * (b[i] as number); na += (a[i] as number) ** 2; nb += (b[i] as number) ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

let failures = 0;
const check = (label: string, cond: boolean): void => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failures++; };

const FLOOR = 0.81; // skill-tools SKILL_EMB_FLOOR
const law = await loadSkill("law-pack", "contract-review", "law-assistant:contract-review");
const med = await loadSkill("medicine-pack", "symptom-triage", "medicine-assistant:symptom-triage");

// ── (1) Activation routing via real embeddings ─────────────────────────────────
const lawUtts = utterances(law), medUtts = utterances(med);
const queries = {
  law: "Can you review this NDA before I sign it?",
  med: "what's a safe ibuprofen dose for a child?",
  off: "what's a good recipe for banana bread?",
};
const all = [queries.law, queries.med, queries.off, ...lawUtts, ...medUtts];
const emb = await embed(all);
const qLaw = emb[0]!, qMed = emb[1]!, qOff = emb[2]!;
const lawEmb = emb.slice(3, 3 + lawUtts.length);
const medEmb = emb.slice(3 + lawUtts.length, 3 + lawUtts.length + medUtts.length);
const maxCos = (q: number[], group: number[][]): number => group.reduce((m, e) => Math.max(m, cosine(q, e)), -1);

const law_law = maxCos(qLaw, lawEmb), law_med = maxCos(qLaw, medEmb);
const med_law = maxCos(qMed, lawEmb), med_med = maxCos(qMed, medEmb);
const off_law = maxCos(qOff, lawEmb), off_med = maxCos(qOff, medEmb);
console.log(`\n  law query   → law=${law_law.toFixed(3)} med=${law_med.toFixed(3)}`);
console.log(`  med query   → law=${med_law.toFixed(3)} med=${med_med.toFixed(3)}`);
console.log(`  off query   → law=${off_law.toFixed(3)} med=${off_med.toFixed(3)}  (floor ${FLOOR})\n`);
check("law query: contract-review scores highest AND clears the activation floor", law_law > law_med && law_law >= FLOOR);
check("medical query: symptom-triage scores highest AND clears the floor", med_med > med_law && med_med >= FLOOR);
check("off-domain query: neither specialist clears the floor (no false activation)", off_law < FLOOR && off_med < FLOOR);

// One streaming chat completion → cleaned answer. STREAMING only (non-stream 500s on this build,
// same path the web app uses). DELIBERATELY no AbortSignal (a mid-decode abort wedges the serve).
// REQUIRED: a non-empty `tools` array — qwen3-4b is served tools:true/toolsMode:dynamic
// ("tools_compact"), which REJECTS a toolless request ("requires non-empty tools for this prompt
// shape"). The web app always sends ≥1 tool; so must we.
const tools = [{ type: "function", function: { name: "noop", description: "unused placeholder (the serve's tools_compact config requires a non-empty tools array)", parameters: { type: "object", properties: {} } } }];
async function streamChat(system: string, user: string, maxTokens: number): Promise<string> {
  const r = await fetch(`${SERVE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer qvac" },
    body: JSON.stringify({ model: "qwen3-4b", messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.6, top_p: 0.95, max_tokens: maxTokens, stream: true, tools }),
  });
  if (!r.ok || !r.body) throw new Error(`chat ${r.status}: ${await r.text()}`);
  let raw = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    for (const line of dec.decode(chunk, { stream: true }).split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        raw += (JSON.parse(d) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";
      } catch {
        /* keepalive / non-JSON line */
      }
    }
  }
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// ── (2) Specialist SKILL inference: the law plugin's contract-review skill body as system prompt ──
const skillAnswer = await streamChat(
  `A skill is ACTIVE for this turn. Follow its instructions to the letter.\n\nSkill "contract-review" is ACTIVE:\n\n${law.body}`,
  'Review this clause: "The Vendor shall not be liable for any damages whatsoever arising out of this Agreement, and the Client waives all claims, regardless of cause."',
  1000,
);
console.log("─── on-device SKILL answer (qwen3-4b + law contract-review skill) ───");
console.log(skillAnswer.slice(0, 900) + "\n…\n");
check("skill answer engages the clause as a contracts reviewer", /liabilit|indemn|one-sided|unfavor|risk|waiv|unenforce|clause/.test(skillAnswer.toLowerCase()));
check("skill answer is substantive (not a refusal/empty)", skillAnswer.length > 200);

// ── (3) SUBAGENT inference: a plugin AGENT run as a focused sub-agent (the agent-runner path) ──
// agent-runner.buildAgentTools makes ONE tool per agent whose execute() runs generateText with the
// agent's .md body as the system prompt. We exercise that exact shape with the real agent body.
const agentBody = splitFrontmatter(await readFile(join(EXAMPLES, "medicine-pack", "agents", "interaction-checker.md"), "utf8"))!.body;
const agentAnswer = await streamChat(agentBody, "Check these medications for interactions: ibuprofen and warfarin.", 800);
console.log("─── on-device SUBAGENT answer (qwen3-4b + medicine interaction-checker AGENT) ───");
console.log(agentAnswer.slice(0, 900) + "\n…\n");
check("subagent runs + flags the ibuprofen↔warfarin interaction by severity", /warfarin/i.test(agentAnswer) && /(major|moderate|severe|contraindicat|bleed|interact)/i.test(agentAnswer));
check("subagent answer is substantive", agentAnswer.length > 150);

console.log(failures === 0 ? "\nLIVE PROOF PASS ✅ — activation routing + on-device SKILL answer + on-device SUBAGENT answer" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
