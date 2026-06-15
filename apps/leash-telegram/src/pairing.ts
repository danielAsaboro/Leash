/**
 * First-run bind (OpenClaw-style pairing). When the allow-list is empty, the daemon prints a
 * 6-digit code to its console; the first Telegram user to send that code is recorded as the
 * owner. After that, pairing is closed and unknown senders are politely refused.
 *
 * The code lives only in process memory + the console — it never goes on the wire, so seeing
 * it requires access to the machine running the daemon (the owner). That IS the capability.
 */
import type { TelegramApi } from "./telegram-api.ts";

export class Pairing {
  /** A fresh 6-digit code, valid only while `active`. */
  readonly code: string;
  /** True until an owner has been bound (i.e. allow-list was empty at boot). */
  active: boolean;

  constructor(active: boolean, private readonly onBind: (userId: number) => void) {
    this.active = active;
    this.code = String(Math.floor(100000 + Math.random() * 900000));
  }

  banner(): string {
    return this.active ? `\n🔗 Pairing open — send this 6-digit code to the bot in Telegram to bind it (owner-only):\n   ${this.code}\n` : "";
  }

  /** Handle a message from a not-yet-allowed sender: match the code → bind, else instruct/refuse. */
  async handle(api: TelegramApi, chatId: number, fromId: number, text: string): Promise<void> {
    if (!this.active) {
      await api.sendMessage(chatId, "⛔ This Leash is bound to its owner and won't respond to you.");
      return;
    }
    if (text.trim() === this.code) {
      this.onBind(fromId);
      this.active = false;
      await api.sendMessage(chatId, "✅ Paired — you're now bound to this Leash. Send me anything.");
    } else {
      await api.sendMessage(chatId, "🔗 To use this Leash, send the 6-digit pairing code shown in its Telegram daemon console.");
    }
  }
}
