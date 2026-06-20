import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import {
  DEVICE_MODEL_PROFILES,
  BRAIN_MODEL_VARIANTS,
  BRAIN_ALWAYS_ON_TOOL_GROUPS,
  BRAIN_MCP_TOOL_GROUPS,
  modelVariantsForCapability,
  modelProfileForDevice,
} from "@mycelium/brain";
import { BRAIN_BUILTIN_AGENTS_DIR, BRAIN_BUILTIN_SKILLS_DIR, materializeBrainBuiltins } from "@mycelium/brain/node";

async function main(): Promise<void> {
  assert.ok(BRAIN_BUILTIN_AGENTS_DIR.includes("packages/brain/builtin-agents"), "agents must be owned by packages/brain");
  assert.ok(BRAIN_BUILTIN_SKILLS_DIR.includes("packages/brain/builtin-skills"), "skills must be owned by packages/brain");
  assert.ok(!existsSync(join(process.cwd(), "apps", "web", "builtin-agents")), "web must not own built-in agents");
  assert.ok(!existsSync(join(process.cwd(), "apps", "web", "builtin-skills")), "web must not own built-in skills");
  assert.ok(existsSync(join(BRAIN_BUILTIN_AGENTS_DIR, "leash.md")), "main Leash agent ships from shared Brain");
  assert.ok(existsSync(join(BRAIN_BUILTIN_SKILLS_DIR, "context-grounding", "SKILL.md")), "context skill ships from shared Brain");

  const tmp = await mkdtemp(join(tmpdir(), "mycelium-brain-"));
  try {
    const dst = join(tmp, "brain");
    await materializeBrainBuiltins(dst);
    const agents = await readdir(join(dst, "builtin-agents"));
    const skills = await readdir(join(dst, "builtin-skills"));
    assert.deepEqual(agents.filter((f) => f.endsWith(".md")).sort(), ["coder.md", "health.md", "leash.md", "researcher.md", "summarizer.md"]);
    assert.ok(skills.includes("context-grounding"), "context-grounding skill materializes");
    const skill = await readFile(join(dst, "builtin-skills", "image-generator", "SKILL.md"), "utf8");
    assert.match(skill, /name:\s*image-generator/, "materialized skill remains a valid SKILL.md");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  assert.deepEqual(DEVICE_MODEL_PROFILES.map((p) => p.id).sort(), ["desktop", "edge", "phone"], "Brain install profiles are device classes");
  const desktop = modelProfileForDevice("desktop");
  const phone = modelProfileForDevice("phone");
  const edge = modelProfileForDevice("edge");
  assert.equal(desktop.id, "desktop");
  assert.equal(phone.id, "phone");
  assert.equal(edge.id, "edge");
  assert.ok(desktop.roles.some((r) => r.role === "vision" && r.projection === "MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K"), "desktop vision includes mmproj");
  assert.ok(
    desktop.roles.some((r) => r.role === "health" && r.alias === "health" && r.src?.includes("qvac/MedPsy-4B-GGUF") && r.downloadName === "medpsy-4b-q4_k_m-imat.gguf"),
    "desktop health must use QVAC MedPsy 4B",
  );
  assert.ok(phone.roles.some((r) => r.role === "chat"), "phone has local chat role");
  assert.ok(
    phone.roles.some((r) => r.role === "health" && r.device === "phone" && r.src?.includes("qvac/MedPsy-1.7B-GGUF") && r.downloadName === "medpsy-1.7b-q4_k_m-imat.gguf"),
    "phone health must use the QVAC MedPsy 1.7B variant",
  );
  assert.ok(phone.roles.some((r) => r.delegateWhen === "unavailable-or-too-heavy"), "phone profile declares delegation fallback");
  assert.ok(edge.roles.some((r) => r.role === "chat" && r.device === "edge"), "edge profile has its own chat variant");
  assert.ok(edge.roles.some((r) => r.role === "health" && r.device === "edge" && r.delegateWhen === "unavailable-or-too-heavy"), "edge profile has delegated health fallback");
  assert.deepEqual(Object.keys(BRAIN_MODEL_VARIANTS).sort(), ["chat", "classifier", "embed", "health", "speech_to_text", "text_to_speech", "vision"], "shared Brain owns capability variants");
  for (const capability of Object.keys(BRAIN_MODEL_VARIANTS) as (keyof typeof BRAIN_MODEL_VARIANTS)[]) {
    const variants = modelVariantsForCapability(capability);
    assert.deepEqual(Object.keys(variants).sort(), ["desktop", "edge", "phone"], `${capability} has desktop/phone/edge variants`);
    assert.equal(variants.desktop.device, "desktop", `${capability} desktop variant is tagged`);
    assert.equal(variants.phone.device, "phone", `${capability} phone variant is tagged`);
    assert.equal(variants.edge.device, "edge", `${capability} edge variant is tagged`);
  }
  assert.ok(BRAIN_MCP_TOOL_GROUPS.some((g) => g.id === "skills"), "shared Brain owns the skills MCP group metadata");
  assert.ok(BRAIN_MCP_TOOL_GROUPS.some((g) => g.id === "mcp-admin"), "shared Brain owns the MCP admin group metadata");
  assert.ok(BRAIN_ALWAYS_ON_TOOL_GROUPS.includes("context"), "shared Brain declares always-on context tools");

  const config = JSON.parse(await readFile(join(process.cwd(), "qvac.config.base.json"), "utf8")) as {
    serve?: { models?: Record<string, { model?: string; src?: string; type?: string }> };
  };
  assert.match(config.serve?.models?.health?.src ?? "", /qvac\/MedPsy-4B-GGUF\/resolve\/main\/medpsy-4b-q4_k_m-imat\.gguf/, "served health alias must be QVAC MedPsy 4B");
  assert.equal(config.serve?.models?.health?.type, "llamacpp-completion", "served health alias must load as a llama.cpp completion model");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
