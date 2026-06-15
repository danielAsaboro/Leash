/**
 * leash-telegram — bind a Telegram bot to the local Leash agent and talk to it from Telegram.
 *
 *   npm run telegram            (from repo root; needs the web app running on :6801)
 *
 * Config: data/leash-telegram.config.json (per-machine, gitignored) or TELEGRAM_BOT_TOKEN env.
 * Owner-only by default: with an empty allow-list, the daemon prints a 6-digit pairing code —
 * send it to the bot once to bind yourself. Transport is long-polling unless config sets
 * "webhook" (then it serves a local listener for a Cloudflare Tunnel + calls setWebhook).
 *
 * Pure transport: inference happens in Leash via @qvac/sdk — this bridge never calls a cloud AI
 * API (hard-rule 1). The Telegram link is inherently online; when offline the poller backs off
 * and resumes (hard-rule 3 governs inference, which stays on-device).
 */
import type { Server } from "node:http";
import { AuditLog } from "@mycelium/shared";
import { addAllowedUser, loadConfig, LOG_DIR } from "./config.ts";
import { TelegramApi, type TgUpdate } from "./telegram-api.ts";
import { Pairing } from "./pairing.ts";
import { handleUpdate, type HandlerDeps } from "./handler.ts";
import { runInLane } from "./lanes.ts";
import { runPolling } from "./transport/polling.ts";
import { runWebhook } from "./transport/webhook.ts";

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const audit = new AuditLog("leash-telegram", LOG_DIR);
  const api = new TelegramApi(cfg.botToken);

  const me = await api.getMe();
  console.log(`🤖 leash-telegram bound to @${me.username ?? me.id} → Leash at ${cfg.leashBaseUrl} (transport: ${cfg.transport})`);

  const pairing = new Pairing(cfg.dmPolicy === "allowlist" && cfg.allowFrom.length === 0, (userId) => {
    addAllowedUser(userId);
    if (!cfg.allowFrom.includes(userId)) cfg.allowFrom.push(userId);
    audit.record({ event: "pairing", extra: { role: "telegram", userId } });
    console.log(`🔗 Paired Telegram user ${userId} as owner.`);
  });
  if (pairing.active) console.log(pairing.banner());

  const deps: HandlerDeps = { cfg, api, audit, pairing };
  // Each update runs in its chat's lane (serialized per chat, parallel across chats).
  const dispatch = (u: TgUpdate): void => runInLane(u.message?.chat?.id ?? 0, () => handleUpdate(u, deps));

  let stopping = false;
  let server: Server | undefined;
  if (cfg.transport === "webhook") server = await runWebhook(cfg, api, dispatch, audit);
  else void runPolling(api, dispatch, audit, () => stopping);

  const quit = async (): Promise<void> => {
    stopping = true;
    try {
      if (cfg.transport === "webhook") await api.deleteWebhook(false);
    } catch {
      /* best-effort */
    }
    server?.close();
    console.log("\n🤖 leash-telegram down");
    process.exit(0);
  };
  process.on("SIGINT", () => void quit());
  process.on("SIGTERM", () => void quit());
}

bootstrap().catch((err) => {
  console.error("leash-telegram failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
