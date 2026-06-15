"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { Notification, NotificationActionKind } from "../lib/leash/notifications-store.ts";

/**
 * Notifications feed (client) — the proactive assistant's voice. Each card shows the title, body,
 * the explainable "why" + tier, and inline actions (Approve · Open chat · Snooze · Dismiss · Always
 * auto) that POST to /api/leash/notifications/[id]. Polls the feed so new heartbeat alerts arrive live.
 */
const TIER_STYLE: Record<string, { label: string; color: string }> = {
  auto: { label: "auto", color: "var(--color-faint)" },
  notify: { label: "notify", color: "var(--color-sage-deep)" },
  ask: { label: "needs approval", color: "var(--color-brick)" },
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function NotificationsPanel({ initial }: { initial: Notification[] }) {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await fetchWithTimeout("/api/leash/notifications?limit=50", { cache: "no-store" }, 4000);
        if (!r.ok || !alive.current) return;
        const data = (await r.json()) as { notifications: Notification[] };
        setItems(data.notifications ?? []);
      } catch {
        /* transient — next tick */
      }
    };
    const id = setInterval(() => void tick(), 15_000);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, []);

  const act = async (id: string, action: NotificationActionKind | "read", ms?: number): Promise<void> => {
    if (action === "open_chat") {
      await act(id, "dismiss"); // mark handled, then take the conversation to chat
      router.push("/chat");
      return;
    }
    setBusy(id);
    try {
      const r = await fetchWithTimeout(`/api/leash/notifications/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: action === "snooze" ? "snooze" : action, ...(ms ? { ms } : {}) }),
      });
      if (r.ok) {
        // Optimistic: snooze/dismiss/always_auto drop the card; read just clears the dot.
        setItems((xs) => (action === "read" ? xs.map((n) => (n.id === id ? { ...n, read: true } : n)) : xs.filter((n) => n.id !== id)));
        router.refresh();
      }
    } catch {
      /* leave the card; the next poll reconciles */
    } finally {
      setBusy(null);
    }
  };

  const labelFor: Record<NotificationActionKind, string> = {
    approve: "Approve",
    open_chat: "Open chat",
    snooze: "Snooze 1h",
    dismiss: "Dismiss",
    always_auto: "Always auto",
  };

  if (items.length === 0) {
    return (
      <p className="kicker py-10 text-center" style={{ color: "var(--color-faint)" }}>
        No notifications — the assistant stays silent until something serves your goals. Set what it watches in Brain → Proactivity.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((n) => {
        const tier = TIER_STYLE[n.tier] ?? TIER_STYLE.notify;
        return (
          <article
            key={n.id}
            className="border p-4"
            style={{ borderColor: n.read ? "var(--color-rule)" : "var(--color-rule-strong)", background: n.read ? "transparent" : "var(--color-paper)" }}
          >
            <div className="mb-1 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {!n.read && <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-brick)" }} />}
                <span className="kicker" style={{ color: tier!.color }}>
                  {tier!.label}
                </span>
              </div>
              <span className="kicker" style={{ color: "var(--color-faint)", fontFamily: "var(--font-mono)", fontSize: "0.68rem" }}>
                {fmtTime(n.ts)}
              </span>
            </div>
            <h3 style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem", fontWeight: 600, color: "var(--color-ink)" }}>{n.title}</h3>
            {n.body && n.body !== n.title && (
              <p className="mt-1 whitespace-pre-wrap" style={{ fontSize: "0.82rem", color: "var(--color-muted)" }}>
                {n.body}
              </p>
            )}
            {n.why && (
              <p className="mt-2" style={{ fontSize: "0.74rem", color: "var(--color-faint)", fontStyle: "italic" }}>
                Why: {n.why}
                {n.goalRef ? ` · goal: ${n.goalRef}` : ""}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {n.actions.map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  disabled={busy === n.id}
                  onClick={() => void act(n.id, a.kind, a.kind === "snooze" ? 60 * 60 * 1000 : undefined)}
                  className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
                  style={
                    a.kind === "approve"
                      ? { borderColor: "var(--color-sage-deep)", background: "var(--color-sage-deep)", color: "var(--color-cream)" }
                      : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }
                  }
                >
                  {labelFor[a.kind] ?? a.label}
                </button>
              ))}
              {!n.read && (
                <button
                  type="button"
                  disabled={busy === n.id}
                  onClick={() => void act(n.id, "read")}
                  className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
                  style={{ borderColor: "var(--color-rule)", color: "var(--color-faint)" }}
                >
                  Mark read
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
