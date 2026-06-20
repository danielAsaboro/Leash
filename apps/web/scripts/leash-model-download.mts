/**
 * Download one SDK model asset into the local cache, reporting progress to a status
 * file — `data/leash-downloads/<NAME>.json`.
 *
 *   npx tsx apps/web/scripts/leash-model-download.mts <SDK_CONSTANT_OR_BRAIN_ASSET_NAME>
 *
 * Spawned DETACHED by `POST /api/leash/models/download` (and runnable by hand): the
 * web process never imports the SDK, and the download survives Next dev restarts —
 * the dashboard polls the status file, not the process. Progress writes are throttled
 * (~2/s) and atomic (tmp+rename) so a poll never reads a torn file.
 */
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelAssetForName } from "@mycelium/brain";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — SDK model constants are runtime exports absent from the .d.ts surface
import * as sdk from "@qvac/sdk";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/scripts → repo root → data/leash-downloads. */
const STATUS_DIR = process.env["LEASH_DOWNLOADS_DIR"] ?? join(here, "..", "..", "..", "data", "leash-downloads");

const name = process.argv[2];

interface Status {
  name: string;
  state: "starting" | "downloading" | "done" | "error";
  percentage: number;
  downloaded: number;
  total: number;
  error?: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
}

/**
 * Translate the SDK's registry-corestore failure signatures into actionable messages.
 * The registry store is SINGLE-PROCESS (exclusive fd-lock, ~10s retry budget) and a
 * serve/hypha that ever needed the registry holds the lock until stopped.
 */
function explainSdkError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("File descriptor could not be locked")) {
    return `${msg} — the model registry is held by a running daemon (a Model Serve or Hypha that fetched registry data keeps the lock until stopped). Stop Model Serve + Hypha, retry this download, then start them again.`;
  }
  if (msg.toLowerCase().includes("moved unsafely")) {
    return `${msg} — the registry store lost its device-file xattr (copied between machines without -X?). Stop all daemons, delete ~/.qvac/registry-corestore/<key>/CORESTORE (lossless, auto-recreated), and retry.`;
  }
  return msg;
}

function writeStatus(s: Status): void {
  mkdirSync(STATUS_DIR, { recursive: true });
  const tmp = join(STATUS_DIR, `.${s.name}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, join(STATUS_DIR, `${s.name}.json`));
}

async function main(): Promise<void> {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error("usage: leash-model-download.mts <SDK_CONSTANT_OR_BRAIN_ASSET_NAME>");
    process.exit(2);
  }
  const constant = (sdk as Record<string, unknown>)[name];
  const isModelConstant = constant !== null && typeof constant === "object" && "src" in (constant as object) && "addon" in (constant as object);
  const brainAsset = isModelConstant ? undefined : modelAssetForName(name);
  const status: Status = { name, state: "starting", percentage: 0, downloaded: 0, total: 0, pid: process.pid, startedAt: Date.now(), updatedAt: Date.now() };
  if (!isModelConstant && !brainAsset) {
    writeStatus({ ...status, state: "error", error: `unknown SDK model constant or Brain asset "${name}"` });
    process.exit(1);
  }
  writeStatus(status);

  let lastWrite = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — downloadAsset is a runtime export
    await sdk.downloadAsset({
      assetSrc: isModelConstant ? constant : brainAsset!.assetSrc,
      onProgress: (p: { percentage: number; downloaded: number; total: number }) => {
        const now = Date.now();
        if (now - lastWrite < 500 && p.percentage < 100) return; // throttle ~2 writes/s
        lastWrite = now;
        writeStatus({ ...status, state: "downloading", percentage: p.percentage, downloaded: p.downloaded, total: p.total, updatedAt: now });
      },
    });
    writeStatus({ ...status, state: "done", percentage: 100, updatedAt: Date.now() });
    console.log(`✅ ${name} downloaded`);
    process.exit(0);
  } catch (err) {
    writeStatus({ ...status, state: "error", error: explainSdkError(err), updatedAt: Date.now() });
    console.error(`❌ ${name} download failed:`, err);
    process.exit(1);
  }
}

void main();
