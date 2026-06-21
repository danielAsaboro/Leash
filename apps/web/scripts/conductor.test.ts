/**
 * Pure assertion tests for the conductor core. No live QVAC serve required.
 * Run: npx tsx apps/web/scripts/conductor.test.ts
 */
import assert from "node:assert/strict";
import {
  buildConductorInventorySystemSection,
  buildConductorPrompt,
  buildConfiguredModelInventory,
  barFromGuardedTurn,
  capabilityBarFromConductorRoute,
  deterministicRouteNeed,
  isHealthIntent,
  invalidConductorFallbackRoute,
  parseConductorDecision,
  pickInventoryRouteAlias,
  publicMeshRouteBlocked,
  type RouterCatalogModel,
  type RouterQvacConfig,
} from "../lib/leash/conductor-core.ts";
import type { RouteOption } from "@mycelium/leash-core/routing";

const catalog: RouterCatalogModel[] = [
  { name: "TEXT_SMALL", endpointCategory: "chat", params: "4B" },
  { name: "HEALTH_SMALL", endpointCategory: "chat", params: "4B" },
  { name: "VISION_SMALL", endpointCategory: "chat", params: "2B" },
  { name: "OCR_LATIN_RECOGNIZER_1", endpointCategory: "ocr", params: "ONNX" },
  { name: "EMBED", endpointCategory: "embedding", params: "1B" },
];

const config: RouterQvacConfig = {
  serve: {
    models: {
      general: {
        model: "TEXT_SMALL",
        preload: true,
        default: true,
        config: { ctx_size: 32768, tools: true, toolsMode: "dynamic" },
      },
      vision: {
        model: "VISION_SMALL",
        preload: true,
        config: { ctx_size: 8192, projectionModelSrc: "~/models/mmproj.gguf" },
      },
      health: {
        model: "HEALTH_SMALL",
        preload: true,
        config: { ctx_size: 8192, tools: true, toolsMode: "dynamic" },
      },
      ocr: {
        model: "OCR_LATIN_RECOGNIZER_1",
        preload: true,
        config: { langList: ["en"], useGPU: true, magRatio: 1.5 },
      },
      embed: "EMBED",
    },
  },
};

const inventory = buildConfiguredModelInventory({
  config,
  catalog,
  live: { up: true, ready: ["general", "vision", "classifier"] },
});

assert.equal(inventory.length, 6, "reads configured aliases plus live-only aliases");
const general = inventory.find((m) => m.alias === "general");
assert.equal(general?.sdkModelName, "TEXT_SMALL", "joins alias to SDK model name");
assert.equal(general?.endpointCategory, "chat", "joins catalog endpoint category");
assert.equal(general?.params, "4B", "joins catalog params");
assert.equal(general?.ctxSize, 32768, "reads ctx_size");
assert.equal(general?.toolsMode, "dynamic", "reads toolsMode");
assert.equal(general?.tools, true, "reads tools flag");
assert.equal(general?.isDefault, true, "reads default");
assert.equal(general?.preload, true, "reads preload");
assert.equal(general?.ready, true, "marks live ready aliases");
assert.equal(inventory.find((m) => m.alias === "vision")?.endpointCategory, "vision", "projection config marks vision capability");
assert.equal(inventory.find((m) => m.alias === "ocr")?.endpointCategory, "ocr", "OCR catalog entry marks OCR capability");
assert.equal(inventory.find((m) => m.alias === "embed")?.ready, false, "reachable serve marks missing alias unavailable");
assert.equal(inventory.find((m) => m.alias === "classifier")?.ready, true, "live-only conductor alias is available to the router");
const prompt = buildConductorPrompt({
  userPrompt: "hi",
  metadata: { messageCount: 1, userTurnCount: 1, voice: false, selectedModel: null, planMode: false },
  inventory,
});
assert.equal(prompt.includes('"inventory"'), false, "turn prompt does not carry model inventory");
const systemInventory = buildConductorInventorySystemSection(inventory);
assert.equal(systemInventory.includes('"alias":"embed"'), false, "unavailable configured aliases are not injected into the conductor system prompt");
assert.equal(systemInventory.includes('"alias":"classifier"'), true, "live available aliases are injected into the conductor system prompt");
assert.equal(deterministicRouteNeed("hi").required, false, "greetings can be direct conductor answers");
assert.equal(deterministicRouteNeed("check whether marker 3 followed marker 2").required, false, "lightweight self-check wording can stay direct");
assert.equal(deterministicRouteNeed("do not use tools; answer one compact sentence").required, false, "negative tool wording does not force full agent routing");
assert.equal(deterministicRouteNeed("do not mention tools; answer one compact sentence").required, false, "negative mention of tools does not force full agent routing");
assert.equal(deterministicRouteNeed("marker 1 starts the run").required, false, "run as a noun does not force full agent routing");
assert.equal(deterministicRouteNeed("use the sandboxed bash tool to run date").required, true, "explicit tool use still routes to the full agent");
const notesNeed = deterministicRouteNeed("search Apple Notes for qvac");
assert.equal(notesNeed.required, true, "notes/search prompts require the full agent");
assert.equal(notesNeed.needsTools, true, "notes/search prompts need tools");
assert.equal(notesNeed.needsMemory, true, "notes/search prompts need memory");
assert.equal(
  pickInventoryRouteAlias({ inventory, conductorAlias: "classifier", selectedModel: null, need: notesNeed }),
  "general",
  "route-required prompts pick the live default chat model, not the conductor",
);

const healthInventory = buildConfiguredModelInventory({
  config,
  catalog,
  live: { up: true, ready: ["general", "health", "classifier"] },
});
const healthNeed = deterministicRouteNeed("I have chest pain and shortness of breath");
assert.equal(isHealthIntent("Can I take this medication with my allergy?"), true, "medication/allergy is health intent");
assert.equal(healthNeed.required, true, "health prompts require full agent routing");
assert.equal(healthNeed.needsHealth, true, "health prompts carry a health flag");
assert.equal(healthNeed.needsMemory, true, "health prompts stay private/context-capable");
assert.equal(
  pickInventoryRouteAlias({ inventory: healthInventory, conductorAlias: "classifier", selectedModel: null, need: healthNeed }),
  "health",
  "health prompts prefer the health specialist alias over the default general model",
);
assert.deepEqual(
  barFromGuardedTurn({ tier: "quick", isImageTurn: false, text: "fever and rash" }),
  { modality: "text", minParamClass: "small", specialist: "health" },
  "health intent still builds a health bar even if effort is quick",
);
assert.deepEqual(
  barFromGuardedTurn({ tier: "quick", isImageTurn: true, text: "read this lab results photo and explain the values" }),
  { modality: "ocr", minParamClass: "tiny", specialist: "ocr" },
  "text-heavy image turns build an OCR capability bar before health interpretation",
);

const validAnswer = parseConductorDecision('{"action":"answer","answer":"Hi."}', inventory);
assert.equal(validAnswer.ok, true, "valid direct answer parses");
if (validAnswer.ok) {
  assert.equal(validAnswer.decision.action, "answer");
  assert.equal(validAnswer.decision.answer, "Hi.");
}

const validRoute = parseConductorDecision(
  '{"action":"route","route":{"alias":"general","reason":"needs memory","needsTools":true,"needsVision":false,"needsMemory":true,"needsFiles":false,"sensitivity":"private"}}',
  inventory,
);
assert.equal(validRoute.ok, true, "valid route parses");
if (validRoute.ok) {
  assert.equal(validRoute.decision.action, "route");
  if (validRoute.decision.action === "route") {
    assert.equal(validRoute.decision.route.alias, "general");
    assert.equal(validRoute.decision.route.needsMemory, true);
  }
}

const unknownAlias = parseConductorDecision(
  '{"action":"route","route":{"alias":"missing","reason":"x","needsTools":false,"needsVision":false,"needsMemory":false,"needsFiles":false,"sensitivity":"private"}}',
  inventory,
);
assert.equal(unknownAlias.ok, false, "unknown route alias rejected");

const unavailableAlias = parseConductorDecision(
  '{"action":"route","route":{"alias":"embed","reason":"x","needsTools":false,"needsVision":false,"needsMemory":false,"needsFiles":false,"sensitivity":"private"}}',
  inventory,
);
assert.equal(unavailableAlias.ok, false, "reachable-but-not-ready alias rejected");

const malformed = parseConductorDecision("not json", inventory);
assert.equal(malformed.ok, false, "malformed conductor text is rejected");

const echoedPrompt = parseConductorDecision('{"userPrompt":"tell me a short joke","turn":{"messageCount":1}}', inventory);
const fallback = invalidConductorFallbackRoute({
  parsed: echoedPrompt,
  userPrompt: "tell me a short joke",
  conductorAlias: "classifier",
  inventory,
  selectedModel: null,
  raw: '{"userPrompt":"tell me a short joke","turn":{"messageCount":1}}',
});
assert.equal(fallback.ok, true, "invalid generic conductor JSON routes to full agent instead of 502");
if (fallback.ok) {
  assert.equal(fallback.decision.action, "route");
  if (fallback.decision.action === "route") {
    assert.equal(fallback.decision.route.alias, "general");
    assert.equal(fallback.decision.route.needsTools, false);
    assert.equal(fallback.decision.route.sensitivity, "shareable");
  }
}

const extraJsonish = parseConductorDecision('```json\n{"action":"answer","answer":"Hi."}\n```\n{"action":"route"}', inventory);
assert.equal(extraJsonish.ok, true, "first balanced valid conductor JSON is accepted even with extra text");
if (extraJsonish.ok) {
  assert.equal(extraJsonish.decision.action, "answer");
}

const bar = capabilityBarFromConductorRoute({
  alias: "vision",
  reason: "image",
  needsTools: false,
  needsVision: true,
  needsMemory: false,
  needsFiles: false,
  sensitivity: "private",
});
assert.equal(bar.modality, "vision", "vision route builds a vision capability bar");
assert.equal(bar.specialist, "vision", "vision route builds a vision specialist bar");

const ocrBar = capabilityBarFromConductorRoute({
  alias: "ocr",
  reason: "document image",
  needsTools: false,
  needsVision: false,
  needsMemory: false,
  needsFiles: false,
  sensitivity: "private",
});
assert.equal(ocrBar.modality, "ocr", "OCR route builds an OCR capability bar");
assert.equal(ocrBar.specialist, "ocr", "OCR route builds an OCR specialist bar");

const meshOptions = [
  {
    tier: "device",
    alias: "local-small",
    tags: { modality: "text", paramClass: "small", specialist: "general" },
    pricePerKiloToken: 0,
    inflight: 0,
  },
  {
    tier: "public",
    alias: "public-large",
    tags: { modality: "text", paramClass: "large", specialist: "general" },
    peerKey: "peer-public",
    meshId: "public-mesh",
    pricePerKiloToken: 500,
    inflight: 0,
  },
] satisfies RouteOption[];
const blocked = publicMeshRouteBlocked({
  bar: { modality: "text", minParamClass: "large" },
  sensitivity: "private",
  options: meshOptions,
});
assert.equal(blocked?.alias, "public-large", "private turns block when only public mesh clears the bar");
assert.equal(
  publicMeshRouteBlocked({ bar: { modality: "text", minParamClass: "large" }, sensitivity: "shareable", options: meshOptions }),
  null,
  "shareable turns do not trigger the private public-mesh block",
);
assert.equal(
  publicMeshRouteBlocked({
    bar: { modality: "text", minParamClass: "small" },
    sensitivity: "private",
    options: meshOptions,
  }),
  null,
  "private turns do not block when this device clears the bar",
);

console.log("conductor: PASS");
