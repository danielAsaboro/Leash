/**
 * A tiny Telegram Bot API client — just the surface this bridge needs. No grammY: the
 * codebase is deliberately dependency-light (leash-broker is raw node:http + undici), and
 * owner-only text DMs touch only a handful of methods. Honors `429 retry_after` with bounded
 * backoff; every call goes through the no-timeout dispatcher (long-poll + slow decodes).
 */
import { fetch as undiciFetch } from "undici";
import { noTimeoutDispatcher, sleep } from "./dispatcher.ts";

export interface TgUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}
export interface TgChat {
  id: number;
  type: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  date: number;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  private base(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  /** POST a Bot API method as JSON, returning `result`. Retries 429s up to 5×, else throws. */
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await undiciFetch(`${this.base()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params ?? {}),
        dispatcher: noTimeoutDispatcher,
      });
      const json = (await res.json()) as TgResponse<T>;
      if (json.ok) return json.result as T;
      if (json.error_code === 429 && json.parameters?.retry_after != null && attempt < 5) {
        await sleep((json.parameters.retry_after + 1) * 1000);
        continue;
      }
      throw new Error(`telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ""}`.trim());
    }
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  /** Long-poll: blocks up to `timeout`s for new messages past `offset`. */
  getUpdates(offset: number, timeout: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout, allowed_updates: ["message"] });
  }

  sendMessage(chatId: number, text: string, parseMode?: string): Promise<unknown> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      disable_web_page_preview: true,
    });
  }

  sendChatAction(chatId: number, action: string): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }

  setWebhook(url: string, secretToken: string): Promise<unknown> {
    return this.call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message"] });
  }

  deleteWebhook(dropPending = false): Promise<unknown> {
    return this.call("deleteWebhook", { drop_pending_updates: dropPending });
  }
}
