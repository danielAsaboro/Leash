/**
 * Per-agent persistent memory (Claude sub-agent `memory:` field, `user` scope). Each memory-enabled
 * agent gets a sandboxed directory <dataDir>/agent-memory/<slug>/ with a MEMORY.md it curates across
 * runs. Tools are JAILED to that directory (no traversal) and are NOT approval-gated (safe by sandbox),
 * so delegates can use them. Mirrors Claude's "Read/Write/Edit auto-enabled on the memory dir."
 *
 * No 'server-only' guard: imported by scripts/agent-memory.test.ts (tsx, outside Next.js). It only
 * does read-only/jailed fs access within the agent's own memory directory.
 */
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DATA_DIR } from "@mycelium/leash-core/json-store";

const BASE = process.env["LEASH_AGENT_MEMORY_DIR"] ?? join(DATA_DIR, "agent-memory");
const MAX_LINES = 200, MAX_BYTES = 25_000;

export function memoryDir(slug: string): string {
  return join(BASE, slug);
}

/** Resolve a relative file inside the agent's dir, rejecting traversal. Returns null if it escapes. */
function jail(slug: string, file: string): string | null {
  const dir = resolve(memoryDir(slug));
  const target = resolve(join(dir, file || "MEMORY.md"));
  return target === dir || target.startsWith(dir + sep) ? target : null;
}

/** The first MAX_LINES / MAX_BYTES of MEMORY.md, wrapped for injection. "" if absent. */
export async function readMemoryContext(slug: string): Promise<string> {
  try {
    let raw = await readFile(join(memoryDir(slug), "MEMORY.md"), "utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES) raw = Buffer.from(raw).subarray(0, MAX_BYTES).toString("utf8");
    raw = raw.split(/\r?\n/).slice(0, MAX_LINES).join("\n");
    return raw.trim() ? `\n\n--- Your persistent memory (read it, and keep MEMORY.md current as you learn) ---\n${raw.trim()}` : "";
  } catch {
    return "";
  }
}

/** Sandboxed read/append/write tools scoped to the agent's memory dir. Auto-granted when `memory:` is set. */
export function agentMemoryTools(slug: string): ToolSet {
  const guard = async (file: string): Promise<string | null> => {
    const p = jail(slug, file);
    if (p) await mkdir(memoryDir(slug), { recursive: true });
    return p;
  };
  return {
    read_memory: tool({
      description: "Read one of your persistent memory files (default MEMORY.md). Your knowledge that survives across runs.",
      inputSchema: z.object({ file: z.string().optional().describe("Relative filename inside your memory dir; default MEMORY.md") }),
      execute: async ({ file }) => {
        const p = await guard(file ?? "MEMORY.md");
        if (!p) return { text: "Refused: path outside your memory directory." };
        try { return { text: await readFile(p, "utf8") }; } catch { return { text: "(empty)" }; }
      },
    }),
    write_memory: tool({
      description: "Overwrite one of your persistent memory files (default MEMORY.md) with new content.",
      inputSchema: z.object({ file: z.string().optional(), content: z.string() }),
      execute: async ({ file, content }) => {
        const p = await guard(file ?? "MEMORY.md");
        if (!p) return { text: "Refused: path outside your memory directory." };
        await writeFile(p, content); return { text: `Saved ${file ?? "MEMORY.md"}.` };
      },
    }),
    append_memory: tool({
      description: "Append a line/section to one of your persistent memory files (default MEMORY.md).",
      inputSchema: z.object({ file: z.string().optional(), content: z.string() }),
      execute: async ({ file, content }) => {
        const p = await guard(file ?? "MEMORY.md");
        if (!p) return { text: "Refused: path outside your memory directory." };
        await appendFile(p, content.endsWith("\n") ? content : content + "\n"); return { text: `Appended to ${file ?? "MEMORY.md"}.` };
      },
    }),
  };
}
