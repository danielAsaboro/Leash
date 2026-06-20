import type { ToolSet } from "ai";

const STOP = new Set([
  "a",
  "about",
  "and",
  "are",
  "code",
  "defined",
  "definition",
  "do",
  "file",
  "files",
  "find",
  "for",
  "from",
  "in",
  "is",
  "it",
  "leash",
  "likely",
  "live",
  "locate",
  "modify",
  "not",
  "of",
  "or",
  "read",
  "search",
  "the",
  "their",
  "to",
  "tool",
  "tools",
  "where",
  "with",
]);

const PRUNE = "-path './node_modules' -o -path './.git' -o -path './.next' -o -path './dist' -o -path './build' -o -path './data' -o -path './logs'";
const NO_SEARCH_RE = /\b(?:do not|don't|dont|without)\s+(?:search|scan|grep|look|find)\b/i;

function shellSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function fileFinderTokens(task: string): string[] {
  return [...new Set((task.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []).filter((t) => !STOP.has(t)))].slice(0, 8);
}

function patternForTask(task: string): string | null {
  const quoted = task.match(/["'`]([^"'`]{2,80})["'`]/)?.[1]?.trim();
  const parts = fileFinderTokens(quoted || task);
  if (!parts.length) return null;
  const variants = new Set<string>();
  for (const part of parts) {
    variants.add(part.replace(/[-_]/g, "[-_ ]?"));
  }
  for (let i = 0; i < parts.length - 1; i++) {
    variants.add(`${parts[i]}[-_ ]?${parts[i + 1]}`);
  }
  return [...variants].join("|");
}

export function fileFinderCommandForTask(task: string): string | null {
  const pattern = patternForTask(task);
  if (!pattern) return null;
  const pathPredicates = fileFinderTokens(task)
    .slice(0, 4)
    .map((t) => `-iname ${shellSingle(`*${t}*`)}`)
    .join(" -o ");
  const quoted = shellSingle(pattern);
  return [
    "printf 'matching files by path:\\n'",
    `find . \\( ${PRUNE} \\) -prune -o -type f \\( ${pathPredicates} \\) -print | head -40`,
    "printf '\\nmatching lines by content:\\n'",
    `{ grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=data --exclude-dir=logs ${quoted} . | head -80; } || true`,
  ].join(" && ");
}

export function shouldRunFileFinderFastPath(task: string): boolean {
  return !NO_SEARCH_RE.test(task) && fileFinderCommandForTask(task) !== null;
}

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  return JSON.stringify(value);
}

export async function runFileFinderFastPath(task: string, registry: ToolSet): Promise<{ text: string; sources: Array<{ kind: "graph"; title: string; snippet: string }> } | null> {
  const command = fileFinderCommandForTask(task);
  const bash = registry["bash"] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> } | undefined;
  if (!command || typeof bash?.execute !== "function") return null;
  const result = await bash.execute({ command }, {});
  return {
    text: outputText(result),
    sources: [{ kind: "graph", title: "Skill · file-finder", snippet: task.slice(0, 120) }],
  };
}
