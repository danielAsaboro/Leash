/**
 * Download one SDK model asset into the local cache, reporting progress to a status
 * file — `data/leash-downloads/<NAME>.json`.
 *
 *   npx tsx apps/web/scripts/leash-model-download.mts <SDK_CONSTANT_NAME>
 *
 * Spawned DETACHED by `POST /api/leash/models/download` (and runnable by hand): the
 * web process never imports the SDK, and the download survives Next dev restarts —
 * the dashboard polls the status file, not the process. Progress writes are throttled
 * (~2/s) and atomic (tmp+rename) so a poll never reads a torn file.
 */
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function writeStatus(s: Status): void {
  mkdirSync(STATUS_DIR, { recursive: true });
  const tmp = join(STATUS_DIR, `.${s.name}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, join(STATUS_DIR, `${s.name}.json`));
}

async function main(): Promise<void> {
  if (!name || !/^[A-Z0-9_]+$/.test(name)) {
    console.error("usage: leash-model-download.mts <SDK_CONSTANT_NAME>");
    process.exit(2);
  }
  const constant = (sdk as Record<string, unknown>)[name];
  const isModelConstant = constant !== null && typeof constant === "object" && "src" in (constant as object) && "addon" in (constant as object);
  const status: Status = { name, state: "starting", percentage: 0, downloaded: 0, total: 0, pid: process.pid, startedAt: Date.now(), updatedAt: Date.now() };
  if (!isModelConstant) {
    writeStatus({ ...status, state: "error", error: `unknown SDK model constant "${name}"` });
    process.exit(1);
  }
  writeStatus(status);

  let lastWrite = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — downloadAsset is a runtime export
    await sdk.downloadAsset({
      assetSrc: constant,
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
    writeStatus({ ...status, state: "error", error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() });
    console.error(`❌ ${name} download failed:`, err);
    process.exit(1);
  }
}

void main();
