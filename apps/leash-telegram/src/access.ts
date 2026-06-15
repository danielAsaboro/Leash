/**
 * The owner-only access guard. Pure + unit-tested: a Telegram sender may reach Leash only
 * when policy allows. "disabled" blocks everyone, "open" allows anyone, "allowlist" (default)
 * permits only the paired owner id(s).
 */
import type { TelegramConfig } from "./config.ts";

export function isOwner(cfg: Pick<TelegramConfig, "dmPolicy" | "allowFrom">, fromId: number): boolean {
  if (cfg.dmPolicy === "disabled") return false;
  if (cfg.dmPolicy === "open") return true;
  return cfg.allowFrom.includes(fromId);
}
