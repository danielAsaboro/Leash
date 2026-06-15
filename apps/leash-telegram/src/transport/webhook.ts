/**
 * Webhook transport. Binds a local HTTP listener (default 127.0.0.1:8787) that a Cloudflare
 * Tunnel fronts with public HTTPS, then registers that public URL with Telegram via setWebhook.
 *
 * Security: every request must carry `X-Telegram-Bot-Api-Secret-Token` matching webhook.secret
 * (Telegram sets it from the setWebhook `secret_token`). We ACK 200 immediately and process the
 * update asynchronously, so a slow agent turn never holds Telegram's delivery — same posture as
 * OpenClaw's webhook lanes.
 */
import http from "node:http";
import type { AuditLog } from "@mycelium/shared";
import type { TelegramConfig } from "../config.ts";
import type { TelegramApi, TgUpdate } from "../telegram-api.ts";

export async function runWebhook(cfg: TelegramConfig, api: TelegramApi, dispatch: (u: TgUpdate) => void, audit: AuditLog): Promise<http.Server> {
  const { path, host, port, secret, url } = cfg.webhook;

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url ?? "") !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    if ((req.headers["x-telegram-bot-api-secret-token"] ?? "") !== secret) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200);
      res.end(); // ACK before processing so the decode never holds Telegram's retry timer.
      try {
        dispatch(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TgUpdate);
      } catch (err) {
        audit.record({ event: "note", extra: { role: "telegram", phase: "webhook-parse-error", error: String(err) } });
      }
    });
    req.on("error", () => {
      try {
        res.writeHead(400);
        res.end();
      } catch {
        /* already closed */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const fullUrl = `${url}${path}`;
  await api.setWebhook(fullUrl, secret);
  audit.record({ event: "note", extra: { role: "telegram", phase: "webhook-start", listen: `${host}:${port}${path}`, public: fullUrl } });
  return server;
}
