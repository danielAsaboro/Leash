/**
 * The core per-message handler: guard → forward to Leash → render the reply. Shared by both
 * transports (polling + webhook). Keeps a `typing…` action alive across the (possibly minutes-
 * long) generation, and degrades honestly when Leash is unreachable.
 */
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";
import type { TelegramConfig } from "./config.ts";
import type { TelegramApi, TgUpdate } from "./telegram-api.ts";
import type { Pairing } from "./pairing.ts";
import { isOwner } from "./access.ts";
import { leashChatIdFor } from "./session.ts";
import { askLeash } from "./leash-client.ts";
import { sendReply } from "./render.ts";

export interface HandlerDeps {
  cfg: TelegramConfig;
  api: TelegramApi;
  audit: AuditLog;
  pairing: Pairing;
}

export async function handleUpdate(update: TgUpdate, deps: HandlerDeps): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text = (msg.text ?? "").trim();

  // Access first: a non-owner only ever reaches the pairing flow (code match or refusal).
  if (!isOwner(deps.cfg, fromId)) {
    if (text) await deps.pairing.handle(deps.api, chatId, fromId, text);
    return;
  }

  if (!text) {
    await deps.api.sendMessage(chatId, "I can only read text messages right now.").catch(() => undefined);
    return;
  }
  if (text === "/start") {
    await deps.api.sendMessage(chatId, "🔌 Connected to Leash. Ask me anything — I run on-device.").catch(() => undefined);
    return;
  }

  deps.audit.record({ event: "note", extra: { role: "telegram", phase: "inbound", chatId, fromId, len: text.length } });

  let typing: ReturnType<typeof setInterval> | undefined;
  const t0 = now();
  try {
    await deps.api.sendChatAction(chatId, "typing").catch(() => undefined);
    // Telegram's typing indicator lasts ~5s; refresh it while Leash decodes.
    typing = setInterval(() => void deps.api.sendChatAction(chatId, "typing").catch(() => undefined), 5000);

    const ans = await askLeash(deps.cfg, leashChatIdFor(chatId), text);
    clearInterval(typing);
    typing = undefined;

    await sendReply(deps.api, chatId, ans.text, deps.cfg.parseMode);
    deps.audit.record({ event: "completion", tokens: ans.totalTokens, ttftMs: ans.ttftMs, durationMs: now() - t0, extra: { role: "telegram", chatId } });
  } catch (err) {
    if (typing) clearInterval(typing);
    deps.audit.record({ event: "note", extra: { role: "telegram", phase: "error", chatId, error: String(err) } });
    await deps.api
      .sendMessage(chatId, `⚠️ Leash is unreachable right now (${deps.cfg.leashBaseUrl}). Make sure the web app is running, then try again.`)
      .catch(() => undefined);
  }
}
