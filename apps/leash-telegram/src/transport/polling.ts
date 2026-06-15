/**
 * Long-polling transport (zero-infra default): repeatedly `getUpdates`, dispatch each update,
 * advance the offset. No public URL, works behind NAT — only outbound HTTPS to Telegram. On
 * error (e.g. offline), back off exponentially and resume when connectivity returns.
 */
import type { AuditLog } from "@mycelium/shared";
import type { TelegramApi, TgUpdate } from "../telegram-api.ts";
import { sleep } from "../dispatcher.ts";

export async function runPolling(api: TelegramApi, dispatch: (u: TgUpdate) => void, audit: AuditLog, stop: () => boolean): Promise<void> {
  // Can't long-poll while a webhook is registered — clear any stale one first.
  await api.deleteWebhook(false).catch(() => undefined);
  audit.record({ event: "note", extra: { role: "telegram", phase: "polling-start" } });

  let offset = 0;
  let backoff = 1000;
  while (!stop()) {
    try {
      const updates = await api.getUpdates(offset, 30);
      backoff = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        dispatch(u);
      }
    } catch (err) {
      if (stop()) break;
      audit.record({ event: "note", extra: { role: "telegram", phase: "poll-error", error: String(err) } });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}
