/**
 * Conservative RSS envelope for the complete Leash/QVAC runtime on one host.
 *
 * Usage:
 *   npm run benchmark:resource-envelope -- --duration-ms 30000
 *   npm run benchmark:resource-envelope -- npm run showcase:dedicated-hardware-flow
 *
 * The sampler sums RSS for every Leash/QVAC process. That deliberately double-counts
 * shared pages across the Node/Bare process tree, making the <=32 GiB assertion a
 * conservative track-compliance guard rather than a flattering estimate.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const durationAt = args.indexOf("--duration-ms");
const durationMs = durationAt >= 0 ? Number(args[durationAt + 1]) : 0;
const command = durationAt >= 0 ? args.slice(0, durationAt) : args;
const limitBytes = Number(process.env["LEASH_RESOURCE_LIMIT_BYTES"] ?? 32 * 1024 ** 3);
const sampleEveryMs = Math.max(100, Number(process.env["LEASH_RESOURCE_SAMPLE_MS"] ?? 250));
const processPattern = new RegExp(
  process.env["LEASH_RESOURCE_PROCESS_PATTERN"]
    ?? "(?:qvac serve|@qvac/sdk/dist/server/worker|apps/hypha/src/main\\.ts|apps/leash-broker/src/main\\.ts|next-server)",
  "i",
);

if ((!Number.isFinite(durationMs) || durationMs < 0) || (command.length === 0 && durationMs === 0)) {
  throw new Error("provide a command to run or --duration-ms <positive milliseconds>");
}

interface ProcessRow {
  pid: number;
  rssBytes: number;
  command: string;
}

interface Sample {
  at: string;
  totalRssBytes: number;
  processes: ProcessRow[];
}

async function sample(): Promise<Sample> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,rss=,command="], { maxBuffer: 4 * 1024 * 1024 });
  const processes = stdout.split("\n").flatMap((line): ProcessRow[] => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !processPattern.test(match[3]!)) return [];
    return [{ pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, command: match[3]!.trim() }];
  });
  return {
    at: new Date().toISOString(),
    totalRssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0),
    processes,
  };
}

const samples: Sample[] = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    samples.push(await sample());
    await new Promise((resolve) => setTimeout(resolve, sampleEveryMs));
  }
})();

let commandExitCode = 0;
const startedAt = Date.now();
try {
  if (command.length > 0) {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env: process.env });
    commandExitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }
} finally {
  sampling = false;
  await sampler;
}

const peak = samples.reduce<Sample | null>((best, entry) => !best || entry.totalRssBytes > best.totalRssBytes ? entry : best, null);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  command,
  commandExitCode,
  limitBytes,
  peakRssBytes: peak?.totalRssBytes ?? 0,
  withinLimit: (peak?.totalRssBytes ?? 0) <= limitBytes,
  processPattern: processPattern.source,
  sampleCount: samples.length,
  peak,
};

await mkdir(join(process.cwd(), "logs"), { recursive: true });
const reportPath = join(process.cwd(), "logs", `resource-envelope-${Date.now().toString(36)}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));

if (commandExitCode !== 0) process.exit(commandExitCode);
if (!report.withinLimit) {
  console.error(`resource envelope exceeded: ${report.peakRssBytes} > ${limitBytes} bytes`);
  process.exit(1);
}
