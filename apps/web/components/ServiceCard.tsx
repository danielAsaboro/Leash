"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ServiceStatus } from "../lib/leash/services.ts";

/**
 * One service's control card (client) — state, freshness, start/stop/restart, log
 * tail. The serve keeps its server-side inflight 409 guard; the confirm dialog is the
 * human backstop. Children render below (e.g. the Cron card hosts the Schedules CRUD).
 */

const STATE_COLOR: Record<ServiceStatus["state"], string> = {
  running: "var(--color-sage)",
  ready: "var(--color-sage)",
  external: "var(--color-sage)",
  starting: "var(--color-faint)",
  stopped: "var(--color-brick)",
  unhealthy: "var(--color-brick)",
};

const STATE_LABEL: Record<ServiceStatus["state"], string> = {
  running: "Running",
  ready: "Ready",
  external: "Running (external)",
  starting: "Starting…",
  stopped: "Stopped",
  unhealthy: "Unhealthy",
};

export function ServiceCard({ service, children }: { service: ServiceStatus; children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const act = async (action: "start" | "stop" | "restart") => {
    const danger = service.name === "qvac-serve" && action !== "start";
    if (danger && !confirm(`${action === "stop" ? "Stop" : "Restart"} the model serve? Make sure no generation is running.`)) return;
    if (action === "stop" && service.name !== "qvac-serve" && !confirm(`Stop ${service.label}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leash/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: service.name, action }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
      }
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  const running = service.state === "running" || service.state === "ready" || service.state === "starting" || service.state === "unhealthy";

  return (
    <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: STATE_COLOR[service.state] }} />
        <span className="kicker kicker-sage">{service.label}</span>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          {STATE_LABEL[service.state]}
          {service.pid ? ` · pid ${service.pid}` : ""} · {service.detail}
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {service.name === "qvac-serve" && (
          <Link href="/brain?tab=models" className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-sage-deep)" }}>
            Models →
          </Link>
        )}
        {!running && service.state !== "external" && (
          <button type="button" disabled={busy} onClick={() => void act("start")} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            Start
          </button>
        )}
        {(running || service.state === "external") && service.stoppable && (
          <>
            <button type="button" disabled={busy} onClick={() => void act("restart")} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
              Restart
            </button>
            <button type="button" disabled={busy} onClick={() => void act("stop")} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
              Stop
            </button>
          </>
        )}
        {service.state === "external" && !service.stoppable && (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            started outside the dashboard
          </span>
        )}
      </div>
      <p className="mt-1.5" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
        {service.blurb}
      </p>
      {error && (
        <p className="kicker mt-2" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {service.logTail.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowLog((v) => !v)} className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>
            {showLog ? "▾ Hide log" : "▸ Show log"} ({service.logTail.length} lines)
          </button>
          {showLog && (
            <pre className="mt-2 overflow-x-auto border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)", fontFamily: "var(--font-mono)", fontSize: "0.68rem", lineHeight: 1.5 }}>
              {service.logTail.join("\n")}
            </pre>
          )}
        </div>
      )}

      {children}
    </section>
  );
}
