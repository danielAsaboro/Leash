import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tagsForAlias } from "../packages/leash-core/src/routing/tags.ts";

const config = JSON.parse(readFileSync("qvac.config.base.json", "utf8")) as {
  serve?: { models?: Record<string, unknown> };
};

const aliases = Object.keys(config.serve?.models ?? {});

assert.ok(aliases.includes("chat"), "serve config must expose capability alias `chat`");
assert.ok(aliases.includes("vision"), "serve config must expose capability alias `vision`");
assert.ok(aliases.includes("stt"), "serve config must expose capability alias `stt`");
assert.ok(aliases.includes("tts"), "serve config must expose capability alias `tts`");
assert.equal(aliases.includes("qwen3-4b"), false, "serve config must not expose model-family alias `qwen3-4b`");
assert.equal(aliases.includes("qwen3vl"), false, "serve config must not expose model-family alias `qwen3vl`");
assert.equal(aliases.includes("parakeet"), false, "serve config must not expose model-family alias `parakeet`");
assert.equal(aliases.includes("supertonic"), false, "serve config must not expose model-family alias `supertonic`");

assert.equal(tagsForAlias("chat").modality, "text", "`chat` must route as text");
assert.equal(tagsForAlias("vision").modality, "vision", "`vision` must route as vision");
assert.equal(tagsForAlias("stt").modality, "stt", "`stt` must route as speech-to-text");
assert.equal(tagsForAlias("tts").modality, "tts", "`tts` must route as text-to-speech");

console.log("smoke-capability-aliases: ok");
