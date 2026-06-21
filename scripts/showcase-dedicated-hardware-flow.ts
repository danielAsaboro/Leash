/**
 * One real product conversation crossing local vision, local TTS→STT, a private
 * document attachment, and two grounded specialist agents.
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { postChat } from "./showcase-multiorchestration-chat.ts";

const WEB_BASE = (process.env["LEASH_WEB_BASE"] ?? "http://127.0.0.1:6801").replace(/\/+$/, "");
const suffix = Date.now().toString(36);
const chatId = `dedicated-hardware-${suffix}`;
const imagePath = join(process.cwd(), "spike", "fixtures", "ocr-note.png");
const privateMarker = `MM9-${suffix.toUpperCase()}`;

interface BrokerStats {
  served?: number;
  overflow?: { shed?: number; availabilityRouted?: number; overflowFailures?: number };
}

async function brokerStats(): Promise<BrokerStats> {
  const response = await fetch("http://127.0.0.1:11436/__broker/stats");
  assert.equal(response.ok, true, "Leash broker must be healthy for the distributed orchestration showcase");
  return response.json() as Promise<BrokerStats>;
}

async function speakAndTranscribe(text: string): Promise<{ text: string; wavBytes: number; speechMs: number; transcriptionMs: number }> {
  const speechStarted = Date.now();
  const speech = await fetch(`${WEB_BASE}/api/leash/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const speechBody = await speech.arrayBuffer();
  assert.equal(speech.ok, true, `local speech failed: ${Buffer.from(speechBody).toString("utf8").slice(0, 500)}`);
  const speechMs = Date.now() - speechStarted;

  const form = new FormData();
  form.append("file", new File([speechBody], "request.wav", { type: "audio/wav" }));
  const transcriptionStarted = Date.now();
  const transcription = await fetch(`${WEB_BASE}/api/leash/transcribe`, { method: "POST", body: form });
  const payload = await transcription.json() as { text?: string; error?: string };
  assert.equal(transcription.ok, true, `local transcription failed: ${payload.error ?? transcription.status}`);
  const transcript = payload.text?.trim() ?? "";
  assert.ok(transcript.length >= 20, "local transcription was unexpectedly empty");
  return { text: transcript, wavBytes: speechBody.byteLength, speechMs, transcriptionMs: Date.now() - transcriptionStarted };
}

const imageBytes = await readFile(imagePath);
const brokerBefore = await brokerStats();
const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const vision = await postChat({
  chatId,
  messageId: `msg-${suffix}-1`,
  text: "Read the greenhouse sensor value and batch ID from this image. Keep the exact values for a later decision.",
  parts: [
    { type: "text", text: "Read the greenhouse sensor value and batch ID from this image. Keep the exact values for a later decision." },
    { type: "file", mediaType: "image/png", filename: "greenhouse-sensor.png", url: imageDataUrl },
  ],
});
const visionText = vision.finalRun.finalSynthesis ?? "";
assert.match(visionText, /24/, "vision turn did not preserve the 24-degree reading");
assert.match(visionText, /QV-2026-0601/i, "vision turn did not preserve the batch id");

const spokenRequest = "Compare the greenhouse image with my private threshold note and keep this request for the next turn.";
const voice = await speakAndTranscribe(spokenRequest);
const voiceTurn = await postChat({
  chatId,
  messageId: `msg-${suffix}-2`,
  text: `This came from Leash on-device speech transcription: ${voice.text}. Confirm the request and retain it for the next turn.`,
  voice: true,
});
assert.match(voiceTurn.responseText, /^Confirmed\./, "voice-context turn returned no persisted-transcript confirmation");

const privateDocument = [
  `Private greenhouse decision note ${privateMarker}.`,
  "The safe operating threshold is 22 degrees Celsius.",
  "A reading above 22 degrees requires an escalation.",
  "The batch ID and measured temperature must be quoted from the image evidence.",
  "Do not infer a reading that was not observed.",
].join("\n");
const privateDataUrl = `data:text/markdown;base64,${Buffer.from(privateDocument).toString("base64")}`;
const finalTask = [
  "Coordinate both Grace and Bree for this decision; do not answer using only one specialist.",
  "Delegate Grace a separate task to use search_graph and active_context to verify the prior image and voice evidence, then evaluate the threshold logic in the attached private note.",
  "Delegate Bree a separate task to use search_graph and active_context to retrieve and summarize the same evidence without inventing missing facts.",
  "After both return, produce one grounded synthesis containing the observed temperature, batch ID, threshold, escalation decision, and private marker.",
].join(" ");
const finalTurn = await postChat({
  chatId,
  messageId: `msg-${suffix}-3`,
  text: finalTask,
  parts: [
    { type: "text", text: finalTask },
    { type: "file", mediaType: "text/markdown", filename: "greenhouse-threshold.md", url: privateDataUrl },
  ],
});

const agents = new Set(finalTurn.agents);
assert.ok(agents.has("agent__coder"), `Grace was not delegated; saw ${[...agents].join(", ")}`);
assert.ok(agents.has("agent__summarizer"), `Bree was not delegated; saw ${[...agents].join(", ")}`);
const finalText = finalTurn.finalRun.finalSynthesis ?? "";
assert.match(finalText, /24/, "parent synthesis omitted the observed temperature");
assert.match(finalText, /QV-2026-0601/i, "parent synthesis omitted the batch id");
assert.match(finalText, /22/, "parent synthesis omitted the threshold");
assert.match(finalText, /escalat/i, "parent synthesis omitted the escalation decision");
assert.match(finalText, new RegExp(privateMarker, "i"), "parent synthesis omitted the private marker");
const brokerAfter = await brokerStats();
const peerShedDelta = (brokerAfter.overflow?.shed ?? 0) - (brokerBefore.overflow?.shed ?? 0);
assert.ok(peerShedDelta >= 1, "multi-agent showcase did not distribute a concurrent specialist to a warm mesh peer");
assert.equal(
  (brokerAfter.overflow?.overflowFailures ?? 0) - (brokerBefore.overflow?.overflowFailures ?? 0),
  0,
  "mesh overflow failed during the distributed orchestration showcase",
);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  chatId,
  qvacOnly: true,
  modalities: {
    image: { path: imagePath, bytes: imageBytes.length, route: vision.finalRun.route, durationMs: vision.durationMs },
    speech: { ...voice, confirmationMs: voiceTurn.durationMs },
    privateDocument: { filename: "greenhouse-threshold.md", bytes: Buffer.byteLength(privateDocument), marker: privateMarker },
  },
  orchestration: {
    runId: finalTurn.finalRun.id,
    agents: [...agents].sort(),
    tools: finalTurn.tools,
    agentContextEvidence: finalTurn.agentContextEvidence,
    durationMs: finalTurn.durationMs,
    broker: { before: brokerBefore, after: brokerAfter, peerShedDelta },
  },
  finalSynthesis: finalText,
};
const logsDir = join(process.cwd(), "logs");
await mkdir(logsDir, { recursive: true });
const reportPath = join(logsDir, `dedicated-hardware-flow-${suffix}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
console.log("showcase:dedicated-hardware-flow PASS");
