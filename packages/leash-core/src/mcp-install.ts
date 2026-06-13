/**
 * Compound MCP-install pipeline (server-only) — the deterministic multi-step work behind the
 * `install_mcp_repo` tool, ported from SmallCode's "compound tool" pattern: small models lose
 * coherence after 3+ sequential tool calls, so instead of making the model chain
 * curl→clone→install→build→detect→register (which it reliably fumbles — wrong cwd, fresh-shell
 * paths, botched start args, silent failures), this does the whole chain in ONE reliable function
 * and hands the model a single structured result.
 *
 * It bakes in the fixes discovered the hard way: resolve a github.com repo out of an mcpservers.org
 * listing; clone (or pull) into the configured workspace; install with yarn↔npm fallback; build,
 * and on TYPE-error build failure fall back to emit-anyway (`tsc --noEmitOnError false`) + alias
 * resolution (`tsc-alias`) so the JS still runs; detect the start command from package.json. The
 * caller (the tool) then registers + connects via the MCP store.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, mkdir } from "node:fs/promises";

/** Where repos are cloned — env-overridable, portable default (matches the mcp-installer skill). */
export const MCP_REPOS_DIR = process.env["LEASH_MCP_REPOS_DIR"] ?? join(homedir(), ".leash-mcp-repos");
/** Package-manager cache + temp, kept on the SAME volume as the repos — npm/yarn otherwise
 *  extract to ~/.cache / TMPDIR on the system disk, which ENOSPC's when that disk is full. */
const CACHE_DIR = join(MCP_REPOS_DIR, ".cache");
const STEP_TIMEOUT_MS = Number(process.env["LEASH_COMMAND_TIMEOUT_MS"] ?? 240_000);

/** Child env: full env so git/npm work, but with PM caches + temp redirected next to the repos. */
const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  YARN_CACHE_FOLDER: join(CACHE_DIR, "yarn"),
  npm_config_cache: join(CACHE_DIR, "npm"),
  TMPDIR: join(CACHE_DIR, "tmp"),
};

export interface InstallResult {
  ok: boolean;
  /** Absolute path of the cloned repo (null if we never got that far). */
  repoDir: string | null;
  /** Detected stdio launch — what to register the server with. */
  command?: string;
  args?: string[];
  /** Human-readable step log (what ran, what each returned). */
  steps: string[];
  /** Set when a step failed hard enough to stop. */
  error?: string;
}

interface StepOut {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one external command with the FULL env (git/npm need PATH, ~/.gitconfig, etc.) and a cap. */
function run(cmd: string, args: string[], cwd: string): Promise<StepOut> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: CHILD_ENV, timeout: STEP_TIMEOUT_MS, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, code: null, stdout, stderr: stderr + `\n${e.message}`, timedOut: false }));
    child.on("close", (code, signal) => resolve({ ok: code === 0, code, stdout, stderr, timedOut: signal === "SIGKILL" }));
  });
}

const tail = (s: string): string => (s.length > 400 ? "…" + s.slice(-400) : s).trim();

function normalizeGitHubRepoUrl(value: string): { url: string; name: string } | null {
  const m = value.trim().match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:[/?#].*)?$/i);
  if (!m) return null;
  const owner = m[1];
  const name = (m[2] ?? "").replace(/\.git$/i, "");
  if (!owner || !name) return null;
  return { url: `https://github.com/${owner}/${name}`, name };
}

/** Normalize a `repository.url` (git+https://…, git://…, …#.git) to a github repo. */
function repoUrlToGithub(repoUrl: unknown): { url: string; name: string } | null {
  if (typeof repoUrl !== "string") return null;
  const cleaned = repoUrl.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/^ssh:\/\/git@/, "https://").replace(/^git@github\.com:/, "https://github.com/");
  return normalizeGitHubRepoUrl(cleaned);
}

/**
 * An `@scope/name`, `scope/name`, or bare npm package name → its github repo. Asks the npm
 * registry for the package's `repository.url` (the reliable mapping), and falls back to
 * `github.com/scope/name` (e.g. `@ankimcp/anki-mcp-server` → github.com/ankimcp/anki-mcp-server).
 */
async function resolveShorthand(input: string): Promise<{ url: string; name: string } | null> {
  const t = input.trim();
  if (!/^@?[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(t)) return null;
  const isPkg = t.startsWith("@") || !t.includes("/");
  if (isPkg) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(t).replace("%40", "@")}`, { redirect: "follow" });
      if (res.ok) {
        const data = (await res.json()) as { repository?: { url?: string }; "dist-tags"?: { latest?: string }; versions?: Record<string, { repository?: { url?: string } }> };
        const latest = data["dist-tags"]?.latest;
        const fromGh = repoUrlToGithub(data.repository?.url ?? (latest ? data.versions?.[latest]?.repository?.url : undefined));
        if (fromGh) return fromGh;
      }
    } catch {
      /* registry unreachable — fall through to the owner/repo guess */
    }
  }
  // `scope/name` → github.com/scope/name (strip a leading @).
  if (t.includes("/")) return normalizeGitHubRepoUrl(`https://github.com/${t.replace(/^@/, "")}`);
  return null;
}

/** Is `pkgName` published to npm with a runnable `bin`? Then it can run via `npx` — no clone/build. */
async function npmRunnable(pkgName: string): Promise<boolean> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName).replace("%40", "@")}`, { redirect: "follow" });
    if (!r.ok) return false;
    const d = (await r.json()) as { "dist-tags"?: { latest?: string }; versions?: Record<string, { bin?: unknown }> };
    const latest = d["dist-tags"]?.latest;
    const v = latest ? d.versions?.[latest] : undefined;
    return !!v?.bin;
  } catch {
    return false;
  }
}

/** The npm package name for the input, if any: a direct `@scope/name`/bare name, or the github repo's package.json `name`. */
async function npmPackageName(input: string, github: { url: string; name: string } | null): Promise<string | null> {
  const t = input.trim();
  if (!/^https?:\/\//i.test(t)) {
    if (/^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(t)) return t; // @scope/name
    if (/^[A-Za-z0-9._-]+$/.test(t)) return t; // bare name
  }
  if (github) {
    const ownerRepo = github.url.replace("https://github.com/", "");
    for (const br of ["HEAD", "main", "master"]) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${ownerRepo}/${br}/package.json`, { redirect: "follow" });
        if (r.ok) {
          const pj = (await r.json()) as { name?: string };
          if (pj?.name) return pj.name;
        }
      } catch {
        /* try next branch */
      }
    }
  }
  return null;
}

/** Resolve ANY identifier to a github.com repo: a github URL, an npm/`@scope/name` package, or a listing page. */
async function resolveRepo(input: string): Promise<{ url: string; name: string } | null> {
  const t = input.trim();
  const direct = normalizeGitHubRepoUrl(t);
  if (direct) return direct;
  if (/^https?:\/\//i.test(t)) {
    // A listing page (mcpservers.org, etc.) — scrape the first github repo link out of its HTML.
    try {
      const res = await fetch(t, { redirect: "follow" });
      if (res.ok) {
        const html = await res.text();
        for (const m of html.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)) {
          const norm = normalizeGitHubRepoUrl(m[0]);
          if (norm) return norm;
        }
      }
    } catch {
      /* unreachable / not HTML */
    }
    return null;
  }
  // Not a URL → an `@scope/name` / `scope/name` / npm package shorthand.
  return resolveShorthand(t);
}

/**
 * Clone → install → build → detect-start for an MCP server repo, deterministically. Returns the
 * detected stdio launch params for the caller to register. Stops at the first hard failure with an
 * honest `error` and the step log so the user knows exactly what broke.
 */
export async function installMcpRepo(rawUrl: string): Promise<InstallResult> {
  const steps: string[] = [];
  const fail = (error: string, repoDir: string | null = null): InstallResult => ({ ok: false, repoDir, steps, error });

  const repo = await resolveRepo(rawUrl);

  // PRIMARY path: if it's published to npm with a runnable bin, run it via `npx` — no clone, no
  // build, no tsc-alias. This is how MCP clients normally launch a server and skips every place
  // the clone+build path can break. Clone+build (below) is the fallback for repos NOT on npm.
  const npmPkg = await npmPackageName(rawUrl, repo);
  if (npmPkg && (await npmRunnable(npmPkg))) {
    steps.push(`${npmPkg} is published to npm — registering it to run via \`npx -y ${npmPkg}\` (no clone or build needed).`);
    return { ok: true, repoDir: null, command: "npx", args: ["-y", npmPkg], steps };
  }

  if (!repo) return fail(`Couldn't find an npm package or a github.com repo for "${rawUrl}".`);
  steps.push(`Not on npm — cloning + building from ${repo.url}.`);

  const repoDir = join(MCP_REPOS_DIR, repo.name);
  await mkdir(MCP_REPOS_DIR, { recursive: true });
  // Ensure the PM caches/temp exist on the repos' volume (avoids ENOSPC on a full system disk).
  await Promise.all([mkdir(join(CACHE_DIR, "yarn"), { recursive: true }), mkdir(join(CACHE_DIR, "npm"), { recursive: true }), mkdir(join(CACHE_DIR, "tmp"), { recursive: true })]);

  // Clone, or pull if it's already there (idempotent re-install).
  const clone = await run("git", ["clone", `${repo.url}.git`, repoDir], MCP_REPOS_DIR);
  if (clone.ok) {
    steps.push(`Cloned into ${repoDir}`);
  } else if (/already exists/i.test(clone.stderr)) {
    const pull = await run("git", ["-C", repoDir, "pull", "--ff-only"], MCP_REPOS_DIR);
    steps.push(`Repo existed — git pull: ${pull.ok ? "up to date" : tail(pull.stderr) || "failed (using existing checkout)"}`);
  } else {
    return fail(`git clone failed: ${tail(clone.stderr) || `exit ${clone.code}`}`, null);
  }

  // package.json — drives install/build/start detection.
  let pkg: { scripts?: Record<string, string>; bin?: unknown; main?: string } = {};
  try {
    pkg = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"));
  } catch {
    return fail("repo has no readable package.json — can't tell how to build/start it.", repoDir);
  }
  const scripts = pkg.scripts ?? {};

  // Install: prefer the lockfile's manager, fall back to the other.
  const hasYarnLock = await readFile(join(repoDir, "yarn.lock"), "utf8").then(() => true).catch(() => false);
  const primary = hasYarnLock ? "yarn" : "npm";
  let inst = await run(primary, primary === "yarn" ? ["install"] : ["install"], repoDir);
  if (!inst.ok) {
    const other = primary === "yarn" ? "npm" : "yarn";
    steps.push(`${primary} install failed (${tail(inst.stderr)}) — trying ${other}`);
    inst = await run(other, ["install"], repoDir);
  }
  if (!inst.ok) return fail(`dependency install failed: ${tail(inst.stderr) || "see log"}`, repoDir);
  steps.push("Dependencies installed.");

  // Build (if there is one). On TYPE-error failure, emit-anyway + alias-resolve so the JS still runs.
  if (scripts["build"]) {
    const build = await run("npm", ["run", "build"], repoDir);
    if (build.ok) {
      steps.push("Build succeeded.");
    } else {
      steps.push(`Build failed (likely type errors) — emitting anyway + resolving path aliases.`);
      await run("npx", ["tsc", "--noEmitOnError", "false"], repoDir); // emits .js despite type errors
      await run("npx", ["tsc-alias"], repoDir); // rewrites @/ aliases so the emitted JS resolves at runtime
    }
  }

  // Detect the stdio launch. A start script is the most robust (it carries any needed node flags);
  // else fall back to the built entrypoint.
  let command: string;
  let args: string[];
  if (scripts["start"]) {
    command = hasYarnLock ? "yarn" : "npm";
    args = ["start"];
  } else {
    const entry = ["build/index.js", "dist/index.js", "index.js", typeof pkg.main === "string" ? pkg.main : ""].find(Boolean) as string;
    command = "node";
    args = [join(repoDir, entry)];
  }
  steps.push(`Start command: ${command} ${args.join(" ")} (cwd ${repoDir})`);

  return { ok: true, repoDir, command, args, steps };
}
