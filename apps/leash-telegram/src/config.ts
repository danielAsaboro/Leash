/**
 * leash-telegram config — loaded once from `data/leash-telegram.config.json` (per-machine,
 * gitignored, NOT shipped by pullmesh) with env overrides. The bot token, the owner
 * allow-list, and the webhook ingress all live here.
 *
 * Mirrors OpenClaw's `channels.telegram` shape so the mental model transfers:
 *   dmPolicy / allowFrom  → who may talk to Leash (owner-only = allowlist with one id)
 *   transport             → "polling" (zero-infra default) | "webhook"
 *   webhook.{url,secret,…} → the Cloudflare-Tunnel public endpoint + secret-token guard
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = join(here, "..");
export const REPO_ROOT = join(here, "..", "..", "..");
/** Per-app audit evidence dir (CLAUDE.md § Audit-log requirement); gitignored. */
export const LOG_DIR = join(APP_ROOT, "logs");
const CONFIG_FILE = process.env["LEASH_TELEGRAM_CONFIG"] ?? join(REPO_ROOT, "data", "leash-telegram.config.json");

export interface WebhookConfig {
  /** Public HTTPS base URL Telegram POSTs to (e.g. your Cloudflare Tunnel hostname). */
  url: string;
  /** Shared secret echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token` — we reject mismatches. */
  secret: string;
  /** Path the local listener serves (default `/telegram-webhook`). */
  path: string;
  /** Local bind host (default `127.0.0.1` — the tunnel fronts it). */
  host: string;
  /** Local bind port (default `8787`). */
  port: number;
}

export interface TelegramConfig {
  botToken: string;
  /** "allowlist" (default, owner-only) · "open" (anyone) · "disabled" (no DMs). */
  dmPolicy: "allowlist" | "open" | "disabled";
  /** Numeric Telegram user ids permitted to talk to Leash. Owner-only = exactly one. */
  allowFrom: number[];
  transport: "polling" | "webhook";
  /** Base URL of the Leash web app exposing POST /api/leash/chat. */
  leashBaseUrl: string;
  /** Telegram parse_mode for replies. Default undefined → plain text (safest). */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  webhook: WebhookConfig;
}

interface FileConfig {
  botToken?: string;
  tokenFile?: string;
  dmPolicy?: TelegramConfig["dmPolicy"];
  allowFrom?: number[];
  transport?: TelegramConfig["transport"];
  leashBaseUrl?: string;
  parseMode?: TelegramConfig["parseMode"];
  webhook?: Partial<WebhookConfig>;
}

let cached: TelegramConfig | null = null;
let tokenFromEnv = false;

/** Load (and cache) the config, applying defaults + env overrides. Throws with a clear hint when misconfigured. */
export function loadConfig(): TelegramConfig {
  if (cached) return cached;
  const file: FileConfig = existsSync(CONFIG_FILE) ? (JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as FileConfig) : {};

  const envToken = process.env["TELEGRAM_BOT_TOKEN"];
  tokenFromEnv = !!envToken;
  let botToken = envToken ?? file.botToken ?? "";
  if (!botToken && file.tokenFile) {
    try {
      botToken = readFileSync(file.tokenFile, "utf8").trim();
    } catch {
      /* fall through to the missing-token error below */
    }
  }
  if (!botToken) {
    throw new Error(`No Telegram bot token. Set TELEGRAM_BOT_TOKEN or "botToken" in ${CONFIG_FILE} (create a bot with @BotFather).`);
  }

  const wf = file.webhook ?? {};
  cached = {
    botToken,
    dmPolicy: file.dmPolicy ?? "allowlist",
    allowFrom: (file.allowFrom ?? []).map(Number).filter((n) => Number.isFinite(n)),
    transport: file.transport ?? "polling",
    leashBaseUrl: (process.env["LEASH_BASE_URL"] ?? file.leashBaseUrl ?? "http://localhost:6801").replace(/\/+$/, ""),
    parseMode: file.parseMode,
    webhook: {
      url: (process.env["LEASH_TELEGRAM_WEBHOOK_URL"] ?? wf.url ?? "").replace(/\/+$/, ""),
      secret: process.env["LEASH_TELEGRAM_WEBHOOK_SECRET"] ?? wf.secret ?? "",
      path: wf.path ?? "/telegram-webhook",
      host: wf.host ?? "127.0.0.1",
      port: Number(wf.port ?? 8787),
    },
  };

  if (cached.transport === "webhook") {
    if (!cached.webhook.url) throw new Error(`webhook transport needs webhook.url (your public Cloudflare Tunnel URL) in ${CONFIG_FILE}`);
    if (!cached.webhook.secret) throw new Error(`webhook transport needs webhook.secret (a random string) in ${CONFIG_FILE}`);
  }
  return cached;
}

/** Record a newly-paired owner and persist it (pairing flow). */
export function addAllowedUser(userId: number): void {
  const cfg = cached ?? loadConfig();
  if (!cfg.allowFrom.includes(userId)) cfg.allowFrom.push(userId);
  persist();
}

/** Write the current config back to disk — omitting the token when it came from the env (don't leak it). */
function persist(): void {
  if (!cached) return;
  const out: FileConfig = {
    dmPolicy: cached.dmPolicy,
    allowFrom: cached.allowFrom,
    transport: cached.transport,
    leashBaseUrl: cached.leashBaseUrl,
    ...(cached.parseMode ? { parseMode: cached.parseMode } : {}),
    webhook: cached.webhook,
  };
  if (!tokenFromEnv) out.botToken = cached.botToken;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + "\n");
}

export { CONFIG_FILE };
